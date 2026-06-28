//! auth-server: регистрация, логин и скины для лаунчера.
//!
//! Шаг 1 дорожной карты. Эндпоинты, нужные лаунчеру прямо сейчас:
//!
//! - `POST /api/register` — `{username, password}` → профиль `{id, name}`
//!   (UUID `id` генерируется строго случайно на сервере).
//! - `POST /api/login` — `{username, password}` → профиль.
//! - `POST /api/skin/import` — импорт скина с лицензии Mojang по нику/UUID.
//! - `GET  /api/skin/:uuid` — отдаёт сохранённый PNG-скин.
//! - `GET  /api/profile/:uuid` — профиль по UUID.
//! - `GET  /health` — проверка живости.
//!
//! Yggdrasil-эндпоинты для authlib-injector (тот же процесс/контейнер):
//!
//! - `GET  /` — метаданные API (skinDomains, signaturePublickey).
//! - `POST /authserver/{authenticate,refresh,validate,invalidate}` — токены.
//! - `POST /sessionserver/session/minecraft/join` — регистрация входа.
//! - `GET  /sessionserver/session/minecraft/hasJoined` — проверка сервером.
//! - `GET  /sessionserver/session/minecraft/profile/:uuid` — профиль с текстурами.
//! - `POST /api/profiles/minecraft` — пакетный поиск профилей по имени.
//! - `GET  /textures/:hash` — отдаёт PNG-текстуру по её SHA-256.

mod mojang;
mod yggdrasil;

use std::sync::Arc;
use std::time::Duration;

use tracing_subscriber::prelude::*;

use axum::{
    extract::{Path, Query, State},
    http::{header, HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use serde::{Deserialize, Serialize};
use serde_json::json;
use tower_http::cors::CorsLayer;

use protocol::{
    AccountInfo, AuthResponse, ChallengeStatus, ChallengeStatusRequest, ChangePasswordRequest,
    ChangeUsernameRequest, Credentials, DeleteAccountRequest, LoginResult,
    PasswordResetConfirm, PasswordResetRequest, PasswordlessLoginRequest, PlayerProfile,
    PlayerStats, SessionResponse, SkinImportRequest, SkinModel,
    SkinUploadRequest, TelegramLinkResponse, TwoFactorRequest,
};

use crate::yggdrasil::Keys;
use store::{
    Account, ChallengeOutcome, Store, StoreError, StoredSkin, CHALLENGE_LOGIN_2FA,
    CHALLENGE_PASSWORDLESS, CHALLENGE_PASSWORD_RESET, SETTING_TELEGRAM_USERNAME,
};
use time::format_description::well_known::Rfc3339;

/// Общее состояние сервера.
struct AppState {
    store: Store,
    http: reqwest::Client,
    /// Ключ подписи профилей Yggdrasil.
    keys: Keys,
    /// Публичный базовый URL (без завершающего слэша), под которым
    /// сервер виден игре. Из него строятся URL текстур и skinDomains.
    public_url: String,
}

type Shared = Arc<AppState>;

/// Период фонового обновления импортированных скинов.
const SKIN_REFRESH_INTERVAL: Duration = Duration::from_secs(6 * 60 * 60); // 6 часов

#[tokio::main]
async fn main() {
    let log_dir = std::env::var("LOG_DIR").unwrap_or_else(|_| "logs".into());
    let file_appender = tracing_appender::rolling::daily(&log_dir, "auth-server.log");
    let (non_blocking, _guard) = tracing_appender::non_blocking(file_appender);

    let env_filter = tracing_subscriber::EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| "auth_server=info,tower_http=warn".into());

    tracing_subscriber::registry()
        .with(env_filter)
        .with(tracing_subscriber::fmt::layer().with_writer(std::io::stdout))
        .with(tracing_subscriber::fmt::layer().with_writer(non_blocking))
        .init();

    let http = reqwest::Client::builder()
        .user_agent("launcher-auth-server/0.1")
        .build()
        .expect("failed to build http client");

    // Публичный URL для текстур и skinDomains. Должен быть доступен игре.
    let public_url = std::env::var("AUTH_PUBLIC_URL")
        .ok()
        .map(|s| s.trim().trim_end_matches('/').to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "http://127.0.0.1:8080".to_string());

    // Ключ подписи профилей персистится, чтобы не меняться между перезапусками.
    let key_path = std::env::var("AUTH_KEY_PATH").unwrap_or_else(|_| "yggdrasil_key.pem".into());
    let keys = Keys::load_or_generate(std::path::Path::new(&key_path));

    // PostgreSQL через общий фасад `store`.
    let database_url = std::env::var("DATABASE_URL")
        .expect("переменная окружения DATABASE_URL обязательна (строка подключения PostgreSQL)");
    let store = Store::connect(&database_url)
        .await
        .unwrap_or_else(|e| panic!("не удалось подключиться к БД: {e:?}"));
    tracing::info!("хранилище: PostgreSQL");

    let state = Arc::new(AppState {
        store,
        http,
        keys,
        public_url,
    });

    // Фоновое обновление скинов, импортированных с лицензии.
    tokio::spawn(skin_refresh_loop(state.clone()));
    // Фоновое обновление времени игры из Minecraft stats по SFTP.
    tokio::spawn(playtime_refresh_loop(state.clone()));

    let app = Router::new()
        .route("/health", get(health))
        .route("/api/register", post(register))
        .route("/api/login", post(login))
        .route("/api/login/2fa", post(login_2fa))
        .route("/api/login/2fa/status", post(login_2fa_status))
        .route("/api/login/passwordless", post(login_passwordless))
        .route(
            "/api/login/passwordless/status",
            post(login_passwordless_status),
        )
        .route("/api/password/reset", post(password_reset_start))
        .route("/api/password/reset/status", post(password_reset_status))
        .route("/api/password/reset/confirm", post(password_reset_confirm))
        .route("/api/logout", post(logout))
        .route("/api/session", get(session))
        .route("/api/account", get(account_me))
        .route("/api/account/username", post(change_username))
        .route("/api/account/password", post(change_password))
        .route("/api/account/delete", post(delete_account))
        .route("/api/account/telegram/start", post(telegram_link_start))
        .route("/api/account/telegram/unlink", post(telegram_unlink))
        .route("/api/profile/:uuid", get(profile))
        .route("/api/skin/import", post(skin_import))
        .route("/api/skin/upload", post(skin_upload))
        .route("/api/skin/:uuid", get(skin))
        .route("/api/cape/:uuid", get(cape))
        .route("/api/stats", get(stats_get))
        // --- Yggdrasil / authlib-injector ---
        .route("/", get(ygg_meta))
        .route("/authserver/authenticate", post(ygg_authenticate))
        .route("/authserver/refresh", post(ygg_refresh))
        .route("/authserver/validate", post(ygg_validate))
        .route("/authserver/invalidate", post(ygg_invalidate))
        .route("/sessionserver/session/minecraft/join", post(ygg_join))
        .route(
            "/sessionserver/session/minecraft/hasJoined",
            get(ygg_has_joined),
        )
        .route(
            "/sessionserver/session/minecraft/profile/:uuid",
            get(ygg_profile),
        )
        .route("/api/profiles/minecraft", post(ygg_profiles_by_name))
        .route("/textures/:hash", get(texture))
        .with_state(state)
        .layer(CorsLayer::permissive());

    let addr = std::env::var("AUTH_BIND").unwrap_or_else(|_| "127.0.0.1:8080".into());
    let listener = tokio::net::TcpListener::bind(&addr)
        .await
        .unwrap_or_else(|e| panic!("не удалось привязаться к {addr}: {e}"));
    tracing::info!("auth-server слушает на http://{addr}");

    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await
        .expect("ошибка сервера");
}

async fn shutdown_signal() {
    let _ = tokio::signal::ctrl_c().await;
    tracing::info!("получен сигнал остановки, завершаюсь");
}

/// Единый тип ошибки HTTP-слоя.
struct ApiError {
    status: StatusCode,
    message: String,
}

impl ApiError {
    fn new(status: StatusCode, message: impl Into<String>) -> Self {
        Self {
            status,
            message: message.into(),
        }
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        #[derive(Serialize)]
        struct Body {
            error: String,
        }
        (
            self.status,
            Json(Body {
                error: self.message,
            }),
        )
            .into_response()
    }
}

impl From<StoreError> for ApiError {
    fn from(e: StoreError) -> Self {
        match e {
            StoreError::NameTaken => ApiError::new(StatusCode::CONFLICT, "Это имя уже занято"),
            StoreError::NotFound => ApiError::new(StatusCode::NOT_FOUND, "Аккаунт не найден"),
            StoreError::BadPassword => {
                ApiError::new(StatusCode::UNAUTHORIZED, "Неверный логин или пароль")
            }
            StoreError::TooMany => ApiError::new(
                StatusCode::TOO_MANY_REQUESTS,
                "Слишком часто. Подождите немного и попробуйте снова",
            ),
            StoreError::Backend(msg) => {
                tracing::error!("ошибка хранилища: {msg}");
                ApiError::new(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "Внутренняя ошибка сервера",
                )
            }
        }
    }
}

async fn health() -> &'static str {
    "ok"
}

async fn register(
    State(state): State<Shared>,
    Json(creds): Json<Credentials>,
) -> Result<Json<AuthResponse>, ApiError> {
    let username = creds.username.trim();
    if username.len() < 3 {
        return Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            "Имя игрока: минимум 3 символа",
        ));
    }
    if creds.password.len() < 6 {
        return Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            "Пароль: минимум 6 символов",
        ));
    }
    let profile = state.store.register(username, &creds.password).await?;
    let token = state.store.create_session(&profile.id).await?;

    // Уведомляем админов о новой регистрации (через outbox; если бот не
    // настроен — сообщения просто полежат в очереди). Ошибка не должна
    // ломать регистрацию, поэтому только логируем.
    if let Err(e) = state
        .store
        .notify_admins(&format!("Новая регистрация: «{}»", profile.name))
        .await
    {
        tracing::warn!(?e, "не удалось поставить уведомление о регистрации");
    }

    Ok(Json(AuthResponse { profile, token }))
}

/// Человекочитаемое сообщение о блокировке аккаунта.
fn ban_message(account: &Account) -> String {
    let Some(ban) = account.ban.as_ref() else {
        return "Аккаунт заблокирован".to_string();
    };
    let mut msg = match ban.until {
        Some(until) => {
            let when = until.format(&Rfc3339).unwrap_or_else(|_| until.to_string());
            format!("Аккаунт заблокирован до {when}")
        }
        None => "Аккаунт заблокирован навсегда".to_string(),
    };
    if let Some(reason) = ban.reason.as_deref().filter(|r| !r.trim().is_empty()) {
        msg.push_str(": ");
        msg.push_str(reason);
    }
    msg
}

/// Отклоняет вход, если аккаунт под активной блокировкой.
async fn ensure_not_banned(state: &Shared, uuid: &str) -> Result<(), ApiError> {
    if let Some(account) = state.store.find_by_uuid(uuid).await {
        if account.is_banned() {
            return Err(ApiError::new(StatusCode::FORBIDDEN, ban_message(&account)));
        }
    }
    Ok(())
}

async fn login(
    State(state): State<Shared>,
    Json(creds): Json<Credentials>,
) -> Result<Json<LoginResult>, ApiError> {
    let profile = state
        .store
        .login(creds.username.trim(), &creds.password)
        .await?;
    ensure_not_banned(&state, &profile.id).await?;

    // Если у аккаунта привязан Telegram — требуем второй фактор: генерируем
    // код, кладём его в outbox на доставку ботом и возвращаем challenge.
    // start_2fa возвращает None, если Telegram не привязан (2FA неприменима).
    match state.store.start_2fa(&profile.id).await? {
        Some(challenge) => Ok(Json(LoginResult::TwoFactorRequired {
            challenge,
            hint: Some("Подтвердите вход в Telegram или введите код".to_string()),
            button_approval: true,
        })),
        None => {
            let token = state.store.create_session(&profile.id).await?;
            Ok(Json(LoginResult::Ok(AuthResponse { profile, token })))
        }
    }
}

/// Подтверждение второго фактора: проверяем код по `challenge` и выдаём сессию.
async fn login_2fa(
    State(state): State<Shared>,
    Json(req): Json<TwoFactorRequest>,
) -> Result<Json<AuthResponse>, ApiError> {
    let uuid = state
        .store
        .verify_2fa(&req.challenge, &req.code)
        .await
        .map_err(|e| match e {
            StoreError::BadPassword => ApiError::new(StatusCode::UNAUTHORIZED, "Неверный код"),
            StoreError::NotFound => {
                ApiError::new(StatusCode::UNAUTHORIZED, "Код истёк, войдите заново")
            }
            other => other.into(),
        })?;
    ensure_not_banned(&state, &uuid).await?;
    let account = state
        .store
        .find_by_uuid(&uuid)
        .await
        .ok_or_else(|| ApiError::new(StatusCode::UNAUTHORIZED, "Аккаунт не найден"))?;
    let token = state.store.create_session(&uuid).await?;
    Ok(Json(AuthResponse {
        profile: account.profile(),
        token,
    }))
}

/// Опрос статуса 2FA при подтверждении кнопкой «Это я» в Telegram. Лаунчер
/// периодически опрашивает этот эндпоинт после `TwoFactorRequired`. При
/// подтверждении выдаёт сессию; при отклонении/истечении просит начать заново.
async fn login_2fa_status(
    State(state): State<Shared>,
    Json(req): Json<ChallengeStatusRequest>,
) -> Result<Json<ChallengeStatus>, ApiError> {
    Ok(Json(
        challenge_login_status(&state, &req.challenge, CHALLENGE_LOGIN_2FA).await?,
    ))
}

/// Опрос статуса входа без пароля. Аналогичен `login_2fa_status`, но проверяет
/// назначение `passwordless`.
async fn login_passwordless_status(
    State(state): State<Shared>,
    Json(req): Json<ChallengeStatusRequest>,
) -> Result<Json<ChallengeStatus>, ApiError> {
    Ok(Json(
        challenge_login_status(&state, &req.challenge, CHALLENGE_PASSWORDLESS).await?,
    ))
}

/// Вход без пароля: по нику. Если у аккаунта привязан Telegram — отправляет
/// запрос с кнопкой подтверждения и возвращает `TwoFactorRequired`. Лаунчер
/// затем опрашивает `/api/login/2fa/status`.
///
/// Намеренно не раскрываем, существует ли аккаунт и привязан ли у него
/// Telegram: при отсутствии любого из условий возвращаем единый отказ.
async fn login_passwordless(
    State(state): State<Shared>,
    Json(req): Json<PasswordlessLoginRequest>,
) -> Result<Json<LoginResult>, ApiError> {
    let unavailable = || {
        ApiError::new(
            StatusCode::UNAUTHORIZED,
            "Вход без пароля недоступен для этого аккаунта",
        )
    };
    let uuid = state
        .store
        .uuid_for_telegram_login(req.username.trim())
        .await?
        .ok_or_else(unavailable)?;
    ensure_not_banned(&state, &uuid).await?;
    let challenge = state
        .store
        .start_challenge(&uuid, CHALLENGE_PASSWORDLESS)
        .await?
        .ok_or_else(unavailable)?;
    Ok(Json(LoginResult::TwoFactorRequired {
        challenge,
        hint: Some("Подтвердите вход в Telegram".to_string()),
        button_approval: true,
    }))
}

/// Начинает сброс пароля: по нику аккаунта с привязанным Telegram. Шлёт запрос
/// с кнопкой подтверждения и возвращает challenge.
async fn password_reset_start(
    State(state): State<Shared>,
    Json(req): Json<PasswordResetRequest>,
) -> Result<Json<LoginResult>, ApiError> {
    let unavailable = || {
        ApiError::new(
            StatusCode::UNAUTHORIZED,
            "Сброс пароля недоступен для этого аккаунта",
        )
    };
    let uuid = state
        .store
        .uuid_for_telegram_login(req.username.trim())
        .await?
        .ok_or_else(unavailable)?;
    let challenge = state
        .store
        .start_challenge(&uuid, CHALLENGE_PASSWORD_RESET)
        .await?
        .ok_or_else(unavailable)?;
    Ok(Json(LoginResult::TwoFactorRequired {
        challenge,
        hint: Some("Подтвердите сброс пароля в Telegram".to_string()),
        button_approval: true,
    }))
}

/// Опрос статуса сброса пароля. При подтверждении возвращает `Approved` БЕЗ
/// сессии (`auth: None`) — пароль ещё не сменён, лаунчер должен вызвать
/// `/api/password/reset/confirm` с новым паролем. Запись challenge при этом не
/// удаляется (нужна для confirm), поэтому используем `peek_challenge`.
async fn password_reset_status(
    State(state): State<Shared>,
    Json(req): Json<ChallengeStatusRequest>,
) -> Result<Json<ChallengeStatus>, ApiError> {
    let status = match state
        .store
        .peek_challenge(&req.challenge, Some(CHALLENGE_PASSWORD_RESET))
        .await?
    {
        ChallengeOutcome::Pending => ChallengeStatus::Pending,
        ChallengeOutcome::Approved(_) => ChallengeStatus::Approved { auth: None },
        ChallengeOutcome::Denied => ChallengeStatus::Denied,
        ChallengeOutcome::Expired | ChallengeOutcome::NotFound => ChallengeStatus::Expired,
    };
    Ok(Json(status))
}

/// Завершает сброс пароля: проверяет, что challenge подтверждён кнопкой, и
/// устанавливает новый пароль. Challenge затем уничтожается (одноразовость),
/// а все активные сессии аккаунта аннулируются.
async fn password_reset_confirm(
    State(state): State<Shared>,
    Json(req): Json<PasswordResetConfirm>,
) -> Result<StatusCode, ApiError> {
    if req.new_password.len() < 6 {
        return Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            "Пароль: минимум 6 символов",
        ));
    }
    let uuid = state
        .store
        .consume_approved_challenge(&req.challenge, CHALLENGE_PASSWORD_RESET)
        .await
        .map_err(|e| match e {
            StoreError::NotFound => ApiError::new(
                StatusCode::UNAUTHORIZED,
                "Запрос не подтверждён или истёк, начните заново",
            ),
            other => other.into(),
        })?;
    // set_password уже сбрасывает сессии аккаунта.
    state.store.set_password(&uuid, &req.new_password).await?;
    Ok(StatusCode::NO_CONTENT)
}

/// Общая логика опроса для сценариев входа (2FA и passwordless): при
/// подтверждении выдаёт сессию.
async fn challenge_login_status(
    state: &Shared,
    challenge: &str,
    purpose: &str,
) -> Result<ChallengeStatus, ApiError> {
    match state.store.poll_challenge(challenge, Some(purpose)).await? {
        ChallengeOutcome::Pending => Ok(ChallengeStatus::Pending),
        ChallengeOutcome::Approved(uuid) => {
            ensure_not_banned(state, &uuid).await?;
            let account = state
                .store
                .find_by_uuid(&uuid)
                .await
                .ok_or_else(|| ApiError::new(StatusCode::UNAUTHORIZED, "Аккаунт не найден"))?;
            let token = state.store.create_session(&uuid).await?;
            Ok(ChallengeStatus::Approved {
                auth: Some(AuthResponse {
                    profile: account.profile(),
                    token,
                }),
            })
        }
        ChallengeOutcome::Denied => Ok(ChallengeStatus::Denied),
        ChallengeOutcome::Expired | ChallengeOutcome::NotFound => Ok(ChallengeStatus::Expired),
    }
}

async fn logout(State(state): State<Shared>, headers: HeaderMap) -> Result<StatusCode, ApiError> {
    let token = bearer_token(&headers)?;
    state.store.destroy_session(&token).await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn session(
    State(state): State<Shared>,
    headers: HeaderMap,
) -> Result<Json<SessionResponse>, ApiError> {
    let token = bearer_token(&headers)?;
    let uuid = state
        .store
        .validate_session(&token)
        .await
        .ok_or_else(|| ApiError::new(StatusCode::UNAUTHORIZED, "Сессия недействительна"))?;
    let account = state
        .store
        .find_by_uuid(&uuid)
        .await
        .ok_or_else(|| ApiError::new(StatusCode::UNAUTHORIZED, "Аккаунт сессии не найден"))?;
    Ok(Json(SessionResponse {
        profile: account.profile(),
    }))
}

async fn profile(
    State(state): State<Shared>,
    Path(uuid): Path<String>,
) -> Result<Json<PlayerProfile>, ApiError> {
    let account = state
        .store
        .find_by_uuid(&uuid)
        .await
        .ok_or_else(|| ApiError::new(StatusCode::NOT_FOUND, "Аккаунт не найден"))?;
    Ok(Json(account.profile()))
}

/// Разрешает беарер-сессию в аккаунт владельца.
async fn current_account(state: &Shared, headers: &HeaderMap) -> Result<Account, ApiError> {
    let token = bearer_token(headers)?;
    let uuid = state
        .store
        .validate_session(&token)
        .await
        .ok_or_else(|| ApiError::new(StatusCode::UNAUTHORIZED, "Сессия недействительна"))?;
    state
        .store
        .find_by_uuid(&uuid)
        .await
        .ok_or_else(|| ApiError::new(StatusCode::UNAUTHORIZED, "Аккаунт сессии не найден"))
}

/// Сведения об аккаунте владельца для вкладки «Аккаунт».
async fn account_me(
    State(state): State<Shared>,
    headers: HeaderMap,
) -> Result<Json<AccountInfo>, ApiError> {
    let account = current_account(&state, &headers).await?;
    Ok(Json(AccountInfo {
        profile: account.profile(),
        telegram_linked: account.has_telegram(),
        is_admin: account.is_admin(),
    }))
}

/// Смена ника владельца сессии.
async fn change_username(
    State(state): State<Shared>,
    headers: HeaderMap,
    Json(req): Json<ChangeUsernameRequest>,
) -> Result<Json<PlayerProfile>, ApiError> {
    let account = current_account(&state, &headers).await?;
    let new_name = req.new_username.trim();
    if new_name.len() < 3 {
        return Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            "Имя игрока: минимум 3 символа",
        ));
    }
    let profile = state.store.rename(&account.uuid, new_name).await?;
    Ok(Json(profile))
}

/// Смена пароля владельца сессии (с проверкой текущего).
async fn change_password(
    State(state): State<Shared>,
    headers: HeaderMap,
    Json(req): Json<ChangePasswordRequest>,
) -> Result<StatusCode, ApiError> {
    let account = current_account(&state, &headers).await?;
    if req.new_password.len() < 6 {
        return Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            "Пароль: минимум 6 символов",
        ));
    }
    state
        .store
        .change_password(&account.uuid, &req.current_password, &req.new_password)
        .await?;
    Ok(StatusCode::NO_CONTENT)
}

/// Само-удаление аккаунта владельцем сессии (с подтверждением пароля).
async fn delete_account(
    State(state): State<Shared>,
    headers: HeaderMap,
    Json(req): Json<DeleteAccountRequest>,
) -> Result<StatusCode, ApiError> {
    let account = current_account(&state, &headers).await?;
    state
        .store
        .delete_account_with_password(&account.uuid, &req.password)
        .await?;
    Ok(StatusCode::NO_CONTENT)
}

/// Начинает привязку Telegram: генерирует одноразовый код для `/start <code>`
/// и возвращает его вместе с deep-link на бота (если username бота известен).
///
/// Сама привязка происходит на стороне бота, когда пользователь отправит
/// `/start <code>`. После этого при следующем входе включится 2FA.
async fn telegram_link_start(
    State(state): State<Shared>,
    headers: HeaderMap,
) -> Result<Json<TelegramLinkResponse>, ApiError> {
    let account = current_account(&state, &headers).await?;
    let code = state.store.create_link_token(&account.uuid).await?;

    let bot_username = state
        .store
        .get_setting(SETTING_TELEGRAM_USERNAME)
        .await
        .ok()
        .flatten()
        .filter(|s| !s.trim().is_empty());
    let deep_link = bot_username
        .as_deref()
        .map(|bot| format!("https://t.me/{bot}?start={code}"));

    Ok(Json(TelegramLinkResponse {
        code,
        bot_username,
        deep_link,
    }))
}

/// Отвязка Telegram от аккаунта владельца сессии (отключает 2FA).
async fn telegram_unlink(
    State(state): State<Shared>,
    headers: HeaderMap,
) -> Result<StatusCode, ApiError> {
    let account = current_account(&state, &headers).await?;
    state.store.set_telegram(&account.uuid, None).await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn skin_import(
    State(state): State<Shared>,
    headers: HeaderMap,
    Json(req): Json<SkinImportRequest>,
) -> Result<Json<PlayerProfile>, ApiError> {
    authorize_owner(&state, &headers, &req.uuid).await?;

    // Аккаунт-получатель должен существовать.
    let account = state
        .store
        .find_by_uuid(&req.uuid)
        .await
        .ok_or_else(|| ApiError::new(StatusCode::NOT_FOUND, "Аккаунт не найден"))?;

    let imported = mojang::import_skin(&state.http, req.source.trim())
        .await
        .map_err(|e| ApiError::new(StatusCode::BAD_GATEWAY, e.to_string()))?;

    let stored = StoredSkin::new(
        imported.png,
        imported.model,
        imported.cape_png,
        req.keep_synced.then_some(imported.source_uuid),
    );
    state.store.set_skin(&account.uuid, stored).await?;

    Ok(Json(account.profile()))
}

async fn skin_upload(
    State(state): State<Shared>,
    headers: HeaderMap,
    Json(req): Json<SkinUploadRequest>,
) -> Result<Json<PlayerProfile>, ApiError> {
    use base64::Engine;

    authorize_owner(&state, &headers, &req.uuid).await?;

    let account = state
        .store
        .find_by_uuid(&req.uuid)
        .await
        .ok_or_else(|| ApiError::new(StatusCode::NOT_FOUND, "Аккаунт не найден"))?;

    let png = base64::engine::general_purpose::STANDARD
        .decode(req.png_base64.trim().as_bytes())
        .map_err(|_| ApiError::new(StatusCode::BAD_REQUEST, "Не удалось декодировать PNG"))?;

    // Минимальная валидация: сигнатура PNG.
    if png.len() < 8 || png[..8] != [0x89, b'P', b'N', b'G', b'\r', b'\n', 0x1a, b'\n'] {
        return Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            "Файл не является PNG",
        ));
    }

    // Собственный скин отменяет синхронизацию с Mojang. Плащ при ручной
    // загрузке не задаётся (отдельный поток не требуется сейчас).
    let stored = StoredSkin::new(png, req.model, None, None);
    state.store.set_skin(&account.uuid, stored).await?;

    Ok(Json(account.profile()))
}

fn short_id(value: &str) -> String {
    const MAX: usize = 12;
    if value.chars().count() <= MAX {
        value.to_string()
    } else {
        format!("{}…", value.chars().take(MAX).collect::<String>())
    }
}

fn bearer_token(headers: &HeaderMap) -> Result<String, ApiError> {
    let value = headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .ok_or_else(|| ApiError::new(StatusCode::UNAUTHORIZED, "Нужна авторизация"))?;
    let token = value
        .strip_prefix("Bearer ")
        .ok_or_else(|| ApiError::new(StatusCode::UNAUTHORIZED, "Нужен Bearer-токен"))?
        .trim();
    if token.is_empty() {
        return Err(ApiError::new(StatusCode::UNAUTHORIZED, "Пустой токен"));
    }
    Ok(token.to_string())
}

async fn authorize_owner(
    state: &Shared,
    headers: &HeaderMap,
    requested_uuid: &str,
) -> Result<(), ApiError> {
    let token = bearer_token(headers)?;
    let session_uuid = state
        .store
        .validate_session(&token)
        .await
        .ok_or_else(|| ApiError::new(StatusCode::UNAUTHORIZED, "Сессия недействительна"))?;
    let requested_uuid = requested_uuid.replace('-', "").to_lowercase();
    if session_uuid != requested_uuid {
        return Err(ApiError::new(
            StatusCode::FORBIDDEN,
            "Нельзя менять данные другого аккаунта",
        ));
    }
    Ok(())
}

async fn skin(State(state): State<Shared>, Path(uuid): Path<String>) -> Result<Response, ApiError> {
    let account = state
        .store
        .find_by_uuid(&uuid)
        .await
        .ok_or_else(|| ApiError::new(StatusCode::NOT_FOUND, "Аккаунт не найден"))?;
    let skin = account
        .skin
        .ok_or_else(|| ApiError::new(StatusCode::NOT_FOUND, "Скин не задан"))?;

    let model = match skin.model {
        SkinModel::Slim => "slim",
        SkinModel::Classic => "classic",
    };

    // Если скин импортирован с лицензии с включённой синхронизацией —
    // отдаём UUID источника, чтобы лаунчер смог показать вкладку «С лицензии».
    let mut response = (
        StatusCode::OK,
        [
            (header::CONTENT_TYPE, "image/png"),
            (header::CACHE_CONTROL, "no-cache"),
            (header::HeaderName::from_static("x-skin-model"), model),
        ],
        skin.png,
    )
        .into_response();
    if let Some(source) = skin.sync_source.as_deref() {
        if let Ok(value) = header::HeaderValue::from_str(source) {
            response
                .headers_mut()
                .insert(header::HeaderName::from_static("x-skin-source"), value);
        }
    }
    Ok(response)
}

async fn cape(State(state): State<Shared>, Path(uuid): Path<String>) -> Result<Response, ApiError> {
    let account = state
        .store
        .find_by_uuid(&uuid)
        .await
        .ok_or_else(|| ApiError::new(StatusCode::NOT_FOUND, "Аккаунт не найден"))?;
    let cape = account
        .skin
        .and_then(|s| s.cape)
        .ok_or_else(|| ApiError::new(StatusCode::NOT_FOUND, "Плащ не задан"))?;

    Ok((
        StatusCode::OK,
        [
            (header::CONTENT_TYPE, "image/png"),
            (header::CACHE_CONTROL, "no-cache"),
        ],
        cape.png,
    )
        .into_response())
}

// ===================== Yggdrasil / authlib-injector =====================

/// Ошибка в формате Yggdrasil.
fn ygg_error(status: StatusCode, error: &str, message: &str) -> Response {
    (
        status,
        Json(json!({ "error": error, "errorMessage": message })),
    )
        .into_response()
}

/// Хост (без схемы и порта) из публичного URL — для skinDomains.
fn host_of(url: &str) -> Option<String> {
    let without_scheme = url.split("://").nth(1).unwrap_or(url);
    let host_port = without_scheme.split('/').next().unwrap_or("");
    let host = host_port.split(':').next().unwrap_or("");
    (!host.is_empty()).then(|| host.to_string())
}

/// Собирает Yggdrasil-профиль аккаунта (с URL текстуры, если скин есть).
fn account_profile_json(
    state: &Shared,
    account: &Account,
    with_textures: bool,
    signed: bool,
) -> serde_json::Value {
    let profile = account.profile();
    let (skin_url, cape_url, model) = match &account.skin {
        Some(skin) => (
            Some(format!("{}/textures/{}", state.public_url, skin.sha256)),
            skin.cape
                .as_ref()
                .map(|c| format!("{}/textures/{}", state.public_url, c.sha256)),
            skin.model,
        ),
        None => (None, None, SkinModel::Classic),
    };
    yggdrasil::profile_json(
        &state.keys,
        &profile,
        skin_url.as_deref(),
        cape_url.as_deref(),
        model,
        with_textures,
        signed,
    )
}

/// `GET /` — метаданные API для authlib-injector.
async fn ygg_meta(State(state): State<Shared>) -> Response {
    let mut skin_domains = Vec::new();
    if let Some(host) = host_of(&state.public_url) {
        skin_domains.push(host.clone());
        skin_domains.push(format!(".{host}"));
    }
    Json(json!({
        "meta": {
            "serverName": "Launcher Auth",
            "implementationName": "launcher-auth-server",
            "implementationVersion": env!("CARGO_PKG_VERSION"),
            "feature.non_email_login": true,
        },
        "skinDomains": skin_domains,
        "signaturePublickey": state.keys.public_pem(),
    }))
    .into_response()
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AuthenticateReq {
    username: String,
    password: String,
    #[serde(default)]
    client_token: Option<String>,
}

/// `POST /authserver/authenticate` — логин по нику/паролю, выдаёт токен.
async fn ygg_authenticate(
    State(state): State<Shared>,
    Json(req): Json<AuthenticateReq>,
) -> Response {
    let profile = match state.store.login(req.username.trim(), &req.password).await {
        Ok(p) => p,
        Err(_) => {
            return ygg_error(
                StatusCode::FORBIDDEN,
                "ForbiddenOperationException",
                "Invalid credentials. Invalid username or password.",
            )
        }
    };
    if let Some(account) = state.store.find_by_uuid(&profile.id).await {
        if account.is_banned() {
            return ygg_error(
                StatusCode::FORBIDDEN,
                "ForbiddenOperationException",
                &ban_message(&account),
            );
        }
    }
    let access_token = match state.store.create_session(&profile.id).await {
        Ok(t) => t,
        Err(_) => {
            return ygg_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Error",
                "Failed to create session.",
            )
        }
    };
    let client_token = req
        .client_token
        .unwrap_or_else(|| uuid::Uuid::new_v4().simple().to_string());
    let p = json!({ "id": profile.id, "name": profile.name });
    Json(json!({
        "accessToken": access_token,
        "clientToken": client_token,
        "availableProfiles": [p.clone()],
        "selectedProfile": p,
    }))
    .into_response()
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RefreshReq {
    access_token: String,
    #[serde(default)]
    client_token: Option<String>,
}

/// `POST /authserver/refresh` — выдаёт новый токен взамен старого.
async fn ygg_refresh(State(state): State<Shared>, Json(req): Json<RefreshReq>) -> Response {
    let Some(uuid) = state.store.validate_session(&req.access_token).await else {
        return ygg_error(
            StatusCode::FORBIDDEN,
            "ForbiddenOperationException",
            "Invalid token.",
        );
    };
    let Some(account) = state.store.find_by_uuid(&uuid).await else {
        return ygg_error(
            StatusCode::FORBIDDEN,
            "ForbiddenOperationException",
            "Invalid token.",
        );
    };
    state.store.destroy_session(&req.access_token).await.ok();
    let access_token = match state.store.create_session(&uuid).await {
        Ok(t) => t,
        Err(_) => {
            return ygg_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Error",
                "Failed to create session.",
            )
        }
    };
    let client_token = req
        .client_token
        .unwrap_or_else(|| uuid::Uuid::new_v4().simple().to_string());
    let profile = account.profile();
    Json(json!({
        "accessToken": access_token,
        "clientToken": client_token,
        "selectedProfile": { "id": profile.id, "name": profile.name },
    }))
    .into_response()
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TokenReq {
    access_token: String,
}

/// `POST /authserver/validate` — 204, если токен жив.
async fn ygg_validate(State(state): State<Shared>, Json(req): Json<TokenReq>) -> Response {
    if state
        .store
        .validate_session(&req.access_token)
        .await
        .is_some()
    {
        StatusCode::NO_CONTENT.into_response()
    } else {
        ygg_error(
            StatusCode::FORBIDDEN,
            "ForbiddenOperationException",
            "Invalid token.",
        )
    }
}

/// `POST /authserver/invalidate` — отзывает токен, всегда 204.
async fn ygg_invalidate(State(state): State<Shared>, Json(req): Json<TokenReq>) -> Response {
    state.store.destroy_session(&req.access_token).await.ok();
    StatusCode::NO_CONTENT.into_response()
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct JoinReq {
    access_token: String,
    selected_profile: String,
    server_id: String,
}

/// `POST /sessionserver/session/minecraft/join` — клиент входит на сервер.
async fn ygg_join(State(state): State<Shared>, Json(req): Json<JoinReq>) -> Response {
    let Some(uuid) = state.store.validate_session(&req.access_token).await else {
        tracing::warn!(
            server_id = %short_id(&req.server_id),
            profile = %req.selected_profile,
            "yggdrasil join rejected: invalid access token"
        );
        return ygg_error(
            StatusCode::FORBIDDEN,
            "ForbiddenOperationException",
            "Invalid token.",
        );
    };
    let selected_profile = req.selected_profile.replace('-', "").to_lowercase();
    if uuid != selected_profile {
        tracing::warn!(
            server_id = %short_id(&req.server_id),
            session_uuid = %uuid,
            selected_profile = %selected_profile,
            "yggdrasil join rejected: selected profile does not match token"
        );
        return ygg_error(
            StatusCode::FORBIDDEN,
            "ForbiddenOperationException",
            "Invalid token.",
        );
    }
    tracing::info!(
        server_id = %short_id(&req.server_id),
        uuid = %uuid,
        "yggdrasil join recorded"
    );
    state.store.record_join(&req.server_id, &req.access_token);
    StatusCode::NO_CONTENT.into_response()
}

#[derive(Deserialize)]
struct HasJoinedQuery {
    username: String,
    #[serde(rename = "serverId")]
    server_id: String,
    #[allow(dead_code)]
    #[serde(default)]
    ip: Option<String>,
}

/// `GET /sessionserver/session/minecraft/hasJoined` — сервер проверяет клиента.
async fn ygg_has_joined(State(state): State<Shared>, Query(q): Query<HasJoinedQuery>) -> Response {
    let Some(access_token) = state.store.join_access_token(&q.server_id) else {
        tracing::warn!(
            username = %q.username,
            server_id = %short_id(&q.server_id),
            "yggdrasil hasJoined missed: join not found"
        );
        return StatusCode::NO_CONTENT.into_response();
    };
    let Some(uuid) = state.store.validate_session(&access_token).await else {
        tracing::warn!(
            username = %q.username,
            server_id = %short_id(&q.server_id),
            "yggdrasil hasJoined missed: stored token is invalid"
        );
        return StatusCode::NO_CONTENT.into_response();
    };
    let Some(account) = state.store.find_by_uuid(&uuid).await else {
        tracing::warn!(
            username = %q.username,
            server_id = %short_id(&q.server_id),
            uuid = %uuid,
            "yggdrasil hasJoined missed: account not found"
        );
        return StatusCode::NO_CONTENT.into_response();
    };
    if !account.username.eq_ignore_ascii_case(&q.username) {
        tracing::warn!(
            username = %q.username,
            account = %account.username,
            server_id = %short_id(&q.server_id),
            "yggdrasil hasJoined missed: username mismatch"
        );
        return StatusCode::NO_CONTENT.into_response();
    }
    if account.is_banned() {
        tracing::warn!(
            username = %q.username,
            uuid = %uuid,
            server_id = %short_id(&q.server_id),
            "yggdrasil hasJoined rejected: account banned"
        );
        return StatusCode::NO_CONTENT.into_response();
    }
    tracing::info!(
        username = %q.username,
        uuid = %uuid,
        server_id = %short_id(&q.server_id),
        "yggdrasil hasJoined accepted"
    );
    Json(account_profile_json(&state, &account, true, true)).into_response()
}

#[derive(Deserialize)]
struct ProfileQuery {
    #[serde(default)]
    unsigned: Option<bool>,
}

/// `GET /sessionserver/session/minecraft/profile/:uuid` — профиль с текстурами.
async fn ygg_profile(
    State(state): State<Shared>,
    Path(uuid): Path<String>,
    Query(q): Query<ProfileQuery>,
) -> Response {
    let Some(account) = state.store.find_by_uuid(&uuid).await else {
        return StatusCode::NO_CONTENT.into_response();
    };
    // unsigned по умолчанию true — т.е. без подписи.
    let signed = !q.unsigned.unwrap_or(true);
    Json(account_profile_json(&state, &account, true, signed)).into_response()
}

/// `POST /api/profiles/minecraft` — пакетный поиск профилей по имени.
async fn ygg_profiles_by_name(
    State(state): State<Shared>,
    Json(names): Json<Vec<String>>,
) -> Response {
    let names: Vec<String> = names.into_iter().take(10).collect();
    let accounts = state.store.find_by_names(&names).await;
    let out: Vec<serde_json::Value> = accounts
        .iter()
        .map(|a| {
            let p = a.profile();
            json!({ "id": p.id, "name": p.name })
        })
        .collect();
    Json(out).into_response()
}

/// `GET /textures/:hash` — отдаёт PNG-текстуру по её SHA-256.
async fn texture(State(state): State<Shared>, Path(hash): Path<String>) -> Response {
    let hash = hash.strip_suffix(".png").unwrap_or(&hash);
    let Some(png) = state.store.find_texture_by_hash(hash).await else {
        return StatusCode::NOT_FOUND.into_response();
    };
    (
        StatusCode::OK,
        [
            (header::CONTENT_TYPE, "image/png"),
            (header::CACHE_CONTROL, "public, max-age=31536000"),
        ],
        png,
    )
        .into_response()
}

/// `GET /api/stats` — суммарное время игры и дата последнего запуска.
async fn stats_get(
    State(state): State<Shared>,
    headers: HeaderMap,
) -> Result<Json<PlayerStats>, ApiError> {
    let account = current_account(&state, &headers).await?;
    let (playtime_seconds, last_launched_at) =
        state.store.get_playtime(&account.uuid).await?;
    Ok(Json(PlayerStats {
        playtime_seconds,
        last_launched_at: last_launched_at
            .map(|t| t.format(&Rfc3339).unwrap_or_default()),
    }))
}

/// `POST /api/stats/session` — удалён, статистика читается фоновым циклом.

/// Фоновый цикл: периодически перечитывает скины с Mojang для аккаунтов,
/// у которых включена синхронизация (`keep_synced`).
async fn skin_refresh_loop(state: Shared) {
    let mut ticker = tokio::time::interval(SKIN_REFRESH_INTERVAL);
    // Первый тик срабатывает сразу — пропускаем, чтобы не дёргать Mojang на старте.
    ticker.tick().await;
    loop {
        ticker.tick().await;
        let targets = state.store.synced_skins().await;
        if targets.is_empty() {
            continue;
        }
        tracing::info!("обновляю {} импортированных скинов", targets.len());
        for (uuid, source) in targets {
            match mojang::import_skin(&state.http, &source).await {
                Ok(imported) => {
                    let stored = StoredSkin::new(
                        imported.png,
                        imported.model,
                        imported.cape_png,
                        Some(imported.source_uuid),
                    );
                    if let Err(e) = state.store.set_skin(&uuid, stored).await {
                        tracing::warn!("не удалось сохранить скин {uuid}: {e:?}");
                    }
                }
                Err(e) => tracing::warn!("обновление скина {uuid} не удалось: {e}"),
            }
        }
    }
}

/// Интервал между опросами Minecraft stats по SFTP.
const PLAYTIME_REFRESH_INTERVAL: Duration = Duration::from_secs(15 * 60);

/// Фоновый цикл: каждые 15 мин читает `<stats_path>/<uuid>.json` по SFTP
/// и обновляет `playtime_seconds` для всех аккаунтов.
async fn playtime_refresh_loop(state: Shared) {
    let mut ticker = tokio::time::interval(PLAYTIME_REFRESH_INTERVAL);
    ticker.tick().await; // первый тик — немедленно, пропускаем
    loop {
        ticker.tick().await;
        if let Err(e) = refresh_playtime_once(&state).await {
            tracing::warn!("playtime refresh failed: {e}");
        }
    }
}

/// Минимальный обработчик SSH-клиента: принимаем любой ключ сервера.
/// Хост задаётся администратором вручную — ответственность оператора.
struct SftpHandler;

impl russh::client::Handler for SftpHandler {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        _key: &russh::keys::ssh_key::PublicKey,
    ) -> Result<bool, Self::Error> {
        Ok(true)
    }
}

async fn refresh_playtime_once(state: &AppState) -> Result<(), String> {
    use russh_sftp::protocol::OpenFlags;
    use tokio::io::AsyncReadExt;

    let get = |key| {
        let store = &state.store;
        async move {
            store
                .get_setting(key)
                .await
                .map_err(|e| format!("db: {e}"))?
                .filter(|s| !s.trim().is_empty())
                .ok_or_else(|| format!("настройка `{key}` не задана"))
        }
    };

    let host = get(store::SETTING_SFTP_HOST).await?;
    let username = get(store::SETTING_SFTP_USERNAME).await?;
    let password = get(store::SETTING_SFTP_PASSWORD).await?;
    let stats_path = get(store::SETTING_SFTP_STATS_PATH).await?;

    // host или host:port
    let (host_part, port) = match host.rsplit_once(':') {
        Some((h, p)) => match p.parse::<u16>() {
            Ok(port) => (h.to_string(), port),
            Err(_) => (host.clone(), 22),
        },
        None => (host.clone(), 22),
    };

    let config = Arc::new(russh::client::Config::default());
    let mut ssh = russh::client::connect(config, (host_part.as_str(), port), SftpHandler)
        .await
        .map_err(|e| format!("ssh connect: {e}"))?;
    let ok = ssh
        .authenticate_password(&username, &password)
        .await
        .map_err(|e| format!("ssh auth: {e}"))?;
    if !matches!(ok, russh::client::AuthResult::Success) {
        return Err("SFTP-аутентификация не прошла".into());
    }
    let channel = ssh
        .channel_open_session()
        .await
        .map_err(|e| format!("channel: {e}"))?;
    channel
        .request_subsystem(true, "sftp")
        .await
        .map_err(|e| format!("sftp subsystem: {e}"))?;
    let sftp = russh_sftp::client::SftpSession::new(channel.into_stream())
        .await
        .map_err(|e| format!("sftp session: {e}"))?;

    // Читаем все uuid аккаунтов из БД
    let uuids = state
        .store
        .all_account_uuids()
        .await
        .map_err(|e| format!("db uuids: {e}"))?;

    let stats_path = stats_path.trim_end_matches('/');
    for uuid in &uuids {
        let path = format!("{stats_path}/{uuid}.json");
        let mut file = match sftp
            .open_with_flags(&path, OpenFlags::READ)
            .await
        {
            Ok(f) => f,
            Err(_) => continue, // файл не существует — игрок ещё не играл
        };
        let mut buf = Vec::new();
        if file.read_to_end(&mut buf).await.is_err() {
            continue;
        }
        let ticks: i64 = match parse_play_time(&buf) {
            Some(t) => t,
            None => continue,
        };
        let seconds = ticks / 20;
        if let Err(e) = state.store.set_playtime_absolute(uuid, seconds).await {
            tracing::warn!("set_playtime_absolute({uuid}): {e:?}");
        }
    }
    Ok(())
}

/// Извлекает `stats.minecraft.custom["minecraft:play_time"]` из JSON-файла статистики.
fn parse_play_time(data: &[u8]) -> Option<i64> {
    let v: serde_json::Value = serde_json::from_slice(data).ok()?;
    v.pointer("/stats/minecraft:custom/minecraft:play_time")
        .and_then(|x| x.as_i64())
}
