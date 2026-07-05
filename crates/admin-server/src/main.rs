//! Admin REST API.
//!
//! Веб-админка (`admin-web`) ходит сюда с bearer-токеном админа. Сервер
//! управляет сборкой (модпаком): создаёт сборки, принимает файлы (моды,
//! конфиги), складывает их байты в каталог `modpack-data` под именем `sha1`,
//! а метаданные — в общий `store`. Лаунчер тянет отсюда клиентский манифест
//! (`GET /manifest`) и сами файлы (`GET /files/<sha1>`).
//!
//! Доступ к БД и сессиям переиспользуется из крейта `store` — те же аккаунты
//! и токены, что и у auth-server. Админом считается аккаунт с ролью `admin`.

use std::path::PathBuf;
use std::str::FromStr;
use std::sync::Arc;
use std::time::{Duration, Instant};

use tracing_subscriber::prelude::*;

use axum::{
    extract::{DefaultBodyLimit, Multipart, Path, Query, State},
    http::{header, HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post, put},
    Json, Router,
};
use serde::{Deserialize, Serialize};
use sha1::{Digest, Sha1};
use store::{
    NewBuild, Role, Store, SETTING_SFTP_HOST, SETTING_SFTP_PASSWORD,
    SETTING_SFTP_STATS_PATH, SETTING_SFTP_USERNAME, SETTING_TELEGRAM_TOKEN, SETTING_TELEGRAM_USERNAME,
};
use time::format_description::well_known::Rfc3339;
use time::OffsetDateTime;
use tokio::sync::Mutex;
use tower_http::cors::CorsLayer;
use tower_http::services::ServeDir;
use futures_util::TryStreamExt;

/// Максимальный размер тела запроса на загрузку файла (один мод/конфиг).
const MAX_UPLOAD_BYTES: usize = 512 * 1024 * 1024; // 512 МБ

/// Метаданные последней сборки authlib-injector у апстрима.
const AUTHLIB_INJECTOR_LATEST: &str = "https://authlib-injector.yushi.moe/artifact/latest.json";

/// Как часто перепроверять апстрим на новую версию инжектора.
const INJECTOR_TTL: Duration = Duration::from_secs(6 * 60 * 60); // 6 часов

type Shared = Arc<AppState>;

struct AppState {
    store: Store,
    /// Каталог с байтами файлов сборки (modpack-data).
    modpack_dir: PathBuf,
    /// Публичный префикс, под которым лаунчер качает файлы (напр.
    /// `https://host/files`). Подставляется в URL манифеста.
    files_base_url: String,
    /// HTTP-клиент к апстриму authlib-injector.
    http: reqwest::Client,
    /// Кэш jar-файла authlib-injector (см. `INJECTOR_TTL`).
    injector: Mutex<Option<InjectorCache>>,
    /// Защита от параллельных SFTP-синхронизаций одной панели.
    sync_to_panel_running: Mutex<Option<i64>>,
    /// Последний статус SFTP-синхронизации для polling из админки.
    sync_to_panel_status: Mutex<SyncStatus>,
    /// Защита от параллельных деплоев мода.
    deploy_mod_running: Mutex<bool>,
    /// Последний статус деплоя мода для polling из админки.
    deploy_mod_status: Mutex<DeployModStatus>,
}

/// Закэшированный authlib-injector.jar с временем загрузки.
struct InjectorCache {
    bytes: Vec<u8>,
    fetched: Instant,
}

#[tokio::main]
async fn main() {
    let log_dir = std::env::var("LOG_DIR").unwrap_or_else(|_| "logs".into());
    let file_appender = tracing_appender::rolling::daily(&log_dir, "admin-server.log");
    let (non_blocking, _guard) = tracing_appender::non_blocking(file_appender);

    let env_filter = tracing_subscriber::EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| "admin_server=info,tower_http=warn".into());

    tracing_subscriber::registry()
        .with(env_filter)
        .with(tracing_subscriber::fmt::layer().with_writer(std::io::stdout))
        .with(tracing_subscriber::fmt::layer().with_writer(non_blocking))
        .init();

    let database_url = std::env::var("DATABASE_URL")
        .expect("переменная окружения DATABASE_URL обязательна (строка подключения PostgreSQL)");
    let store = Store::connect(&database_url)
        .await
        .unwrap_or_else(|e| panic!("не удалось подключиться к БД: {e:?}"));
    tracing::info!("хранилище: PostgreSQL");

    // Выдача первого админа. Веб-админка пускает только роль `admin`, но
    // регистрация всегда создаёт `user` — поэтому самого первого админа
    // неоткуда взять. `ADMIN_BOOTSTRAP` со списком логинов (через запятую)
    // повышает уже существующие аккаунты до `admin` при старте. Операция
    // идемпотентна: можно держать переменную постоянно, повторный запуск
    // ничего не ломает.
    bootstrap_admins(&store).await;

    let modpack_dir =
        PathBuf::from(std::env::var("MODPACK_DIR").unwrap_or_else(|_| "modpack-data".to_string()));
    std::fs::create_dir_all(&modpack_dir)
        .unwrap_or_else(|e| panic!("не удалось создать каталог сборки {modpack_dir:?}: {e}"));

    // Публичный URL раздачи файлов. По умолчанию — наш же `/files`.
    let files_base_url = std::env::var("FILES_BASE_URL")
        .ok()
        .map(|s| s.trim().trim_end_matches('/').to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "http://127.0.0.1:8081/files".to_string());

    let state = Arc::new(AppState {
        store,
        modpack_dir: modpack_dir.clone(),
        files_base_url,
        http: reqwest::Client::builder()
            .user_agent(concat!("admin-server/", env!("CARGO_PKG_VERSION")))
            .build()
            .expect("не удалось собрать HTTP-клиент"),
        injector: Mutex::new(None),
        sync_to_panel_running: Mutex::new(None),
        sync_to_panel_status: Mutex::new(SyncStatus::default()),
        deploy_mod_running: Mutex::new(false),
        deploy_mod_status: Mutex::new(DeployModStatus::default()),
    });

    // Фоновая задача: синхронизация статистики с SFTP каждые 15 минут.
    let bg_state = Arc::clone(&state);
    tokio::spawn(async move {
        loop {
            match do_sync_stats(&bg_state).await {
                Ok(updated) if updated > 0 => {
                    tracing::info!("[stats] синхронизация: обновлено {updated} игроков");
                }
                Ok(_) => {}
                Err(e) => {
                    tracing::warn!("[stats] синхронизация: {e}");
                }
            }
            tokio::time::sleep(Duration::from_secs(15 * 60)).await;
        }
    });

    let cors = {
        let allowed_origins = std::env::var("CORS_ALLOWED_ORIGINS")
            .ok()
            .map(|s| {
                s.split(',')
                    .map(|o| o.trim().to_string())
                    .filter(|o| !o.is_empty())
                    .collect::<Vec<_>>()
            })
            .filter(|v| !v.is_empty());

        match allowed_origins {
            Some(origins) => {
                tracing::info!("CORS: разрешённые origins: {:?}", origins);
                let mut cors = CorsLayer::new();
                for origin in &origins {
                    if let Ok(o) = origin.parse() {
                        cors = cors.allow_origin([o]);
                    }
                }
                cors
            }
            None => {
                tracing::warn!("CORS: allowed origins не заданы, разрешаем все (только для разработки!)");
                CorsLayer::permissive()
            }
        }
    };

    let app = Router::new()
        .route("/health", get(health))
        // --- Админка (нужен токен админа) ---
        .route("/api/login", post(login))
        .route("/api/logout", post(logout))
        .route("/api/me", get(me))
        .route("/api/settings", get(get_settings).put(update_settings))
        .route("/api/builds", get(list_builds).post(create_build))
        .route(
            "/api/builds/:id",
            get(get_build).patch(update_build).delete(delete_build),
        )
        .route("/api/builds/:id/activate", post(activate_build))
        .route("/api/builds/:id/clone", post(clone_build))
        .route("/api/builds/:id/files", post(upload_file))
        .route(
            "/api/builds/files/:file_id",
            axum::routing::patch(update_file).delete(delete_file),
        )
        .route("/api/builds/:id/sync-to-panel", post(sync_to_panel))
        .route("/api/builds/:id/sync-to-panel/status", get(sync_to_panel_status))
        .route("/api/build-check", get(build_check))
        .route("/api/deps-check", get(deps_check))
        .route("/api/settings/sync-stats", post(sync_stats))
        .route(
            "/api/builds/files/:file_id/content",
            axum::routing::put(update_file_content),
        )
        .route("/api/accounts", get(list_accounts))
        .route(
            "/api/accounts/:uuid",
            axum::routing::patch(update_account).delete(delete_account_admin),
        )
        .route("/api/accounts/:uuid/ban", post(ban_account))
        .route("/api/accounts/:uuid/unban", post(unban_account))
        .route("/api/accounts/:uuid/role", post(set_account_role))
        .route("/api/accounts/:uuid/password", post(set_account_password))
        .route(
            "/api/accounts/:uuid/telegram",
            axum::routing::delete(unlink_account_telegram).put(set_account_telegram),
        )
        .route("/api/accounts/:uuid/skin", get(account_skin))
        .route("/api/accounts/:uuid/stats", get(account_stats))
        .route("/api/accounts/:uuid/customization", get(get_account_customization))
        .route("/api/accounts/:uuid/badges", put(set_account_badges))
        .route("/api/accounts/:uuid/gradients", put(set_account_gradients))
        .route("/api/accounts/:uuid/active", put(set_account_active))
        .route("/api/badges", get(list_badges).post(create_badge))
        .route(
            "/api/badges/:id",
            axum::routing::patch(update_badge).delete(delete_badge),
        )
        .route("/api/gradients", get(list_gradients).post(create_gradient))
        .route(
            "/api/gradients/:id",
            axum::routing::patch(update_gradient).delete(delete_gradient),
        )
        .route("/api/deploy-mod", post(deploy_mod))
        .route("/api/deploy-mod/status", get(deploy_mod_status))
        // --- Публичное для лаунчера ---
        .route("/manifest", get(manifest))
        .route("/authlib-injector.jar", get(authlib_injector))
        .nest_service("/files", ServeDir::new(modpack_dir))
        .layer(DefaultBodyLimit::max(MAX_UPLOAD_BYTES))
        .with_state(state)
        .layer(cors);

    let addr = std::env::var("ADMIN_BIND").unwrap_or_else(|_| "127.0.0.1:8081".into());
    let listener = tokio::net::TcpListener::bind(&addr)
        .await
        .unwrap_or_else(|e| panic!("не удалось привязаться к {addr}: {e}"));
    tracing::info!("admin-server слушает на http://{addr}");

    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await
        .expect("ошибка сервера");
}

async fn shutdown_signal() {
    let _ = tokio::signal::ctrl_c().await;
    tracing::info!("получен сигнал остановки, завершаюсь");
}

/// Повышает до роли `admin` аккаунты, перечисленные в `ADMIN_BOOTSTRAP`
/// (логины через запятую). Нужно, чтобы выдать самого первого админа: иначе
/// зайти в веб-админку и назначить роли некому. Идемпотентно — уже admin'ы
/// пропускаются, отсутствующие аккаунты логируются как предупреждение.
async fn bootstrap_admins(store: &Store) {
    let raw = match std::env::var("ADMIN_BOOTSTRAP") {
        Ok(v) if !v.trim().is_empty() => v,
        _ => return,
    };

    for username in raw.split(',').map(str::trim).filter(|s| !s.is_empty()) {
        match store.find_by_name(username).await {
            Some(account) if account.is_admin() => {
                tracing::info!(username, "bootstrap: уже admin, пропускаю");
            }
            Some(account) => match store.set_role(&account.uuid, Role::Admin).await {
                Ok(()) => tracing::info!(username, "bootstrap: роль повышена до admin"),
                Err(e) => tracing::error!(username, ?e, "bootstrap: не удалось выдать admin"),
            },
            None => tracing::warn!(
                username,
                "bootstrap: аккаунт не найден — сначала зарегистрируйте его в лаунчере"
            ),
        }
    }
}

// ───────────────────────── Ошибки ─────────────────────────

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
        (
            self.status,
            Json(ErrorBody {
                error: self.message,
            }),
        )
            .into_response()
    }
}

#[derive(Serialize)]
struct ErrorBody {
    error: String,
}

// ───────────────────────── Аутентификация ─────────────────────────

#[derive(Deserialize)]
struct LoginRequest {
    username: String,
    password: String,
}

#[derive(Serialize)]
struct LoginResponse {
    token: String,
    username: String,
    uuid: String,
}

async fn health() -> &'static str {
    "ok"
}

/// Вход в админку: логин/пароль + обязательная роль `admin`.
async fn login(
    State(state): State<Shared>,
    Json(req): Json<LoginRequest>,
) -> Result<Json<LoginResponse>, ApiError> {
    let profile = state
        .store
        .login(&req.username, &req.password)
        .await
        .map_err(|_| ApiError::new(StatusCode::UNAUTHORIZED, "Неверный логин или пароль"))?;

    let account = state
        .store
        .find_by_uuid(&profile.id)
        .await
        .ok_or_else(|| ApiError::new(StatusCode::UNAUTHORIZED, "Аккаунт не найден"))?;
    if !account.is_admin() {
        return Err(ApiError::new(StatusCode::FORBIDDEN, "Недостаточно прав"));
    }

    let token = state
        .store
        .create_session(&profile.id)
        .await
        .map_err(internal)?;
    Ok(Json(LoginResponse {
        token,
        username: profile.name,
        uuid: profile.id,
    }))
}

async fn logout(State(state): State<Shared>, headers: HeaderMap) -> Result<StatusCode, ApiError> {
    let token = bearer_token(&headers)?;
    let _ = state.store.destroy_session(&token).await;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Serialize)]
struct MeResponse {
    username: String,
    uuid: String,
}

async fn me(State(state): State<Shared>, headers: HeaderMap) -> Result<Json<MeResponse>, ApiError> {
    let account = require_admin(&state, &headers).await?;
    Ok(Json(MeResponse {
        username: account.username,
        uuid: account.uuid,
    }))
}

// ───────────────────────── Настройки ─────────────────────────

#[derive(Serialize)]
struct SettingsDto {
    /// Привязан ли токен бота. Сам токен наружу не отдаём (секрет).
    #[serde(rename = "telegramTokenSet")]
    telegram_token_set: bool,
    /// Закэшированный username бота (`@name`), если бот уже представился.
    #[serde(
        rename = "telegramBotUsername",
        skip_serializing_if = "Option::is_none"
    )]
    telegram_bot_username: Option<String>,
    /// SFTP-хост сервера (`host` или `host:port`).
    #[serde(rename = "sftpHost", skip_serializing_if = "Option::is_none")]
    sftp_host: Option<String>,
    /// SFTP-логин.
    #[serde(rename = "sftpUsername", skip_serializing_if = "Option::is_none")]
    sftp_username: Option<String>,
    /// Установлен ли SFTP-пароль (сам пароль наружу не отдаём).
    #[serde(rename = "sftpPasswordSet")]
    sftp_password_set: bool,
    /// Путь к папке со статистикой на SFTP-сервере.
    #[serde(rename = "sftpStatsPath", skip_serializing_if = "Option::is_none")]
    sftp_stats_path: Option<String>,
}

async fn load_settings_dto(state: &Shared) -> Result<SettingsDto, ApiError> {
    let keys = [
        SETTING_TELEGRAM_TOKEN,
        SETTING_TELEGRAM_USERNAME,
        SETTING_SFTP_HOST,
        SETTING_SFTP_USERNAME,
        SETTING_SFTP_PASSWORD,
        SETTING_SFTP_STATS_PATH,
    ];
    let map = state
        .store
        .get_settings_batch(&keys)
        .await
        .map_err(internal)?;

    let get = |key: &str| -> Option<String> {
        map.get(key)
            .and_then(|v| v.clone())
    };

    Ok(SettingsDto {
        telegram_token_set: get(SETTING_TELEGRAM_TOKEN)
            .map(|t| !t.trim().is_empty())
            .unwrap_or(false),
        telegram_bot_username: get(SETTING_TELEGRAM_USERNAME)
            .filter(|u| !u.trim().is_empty()),
        sftp_host: get(SETTING_SFTP_HOST).filter(|s| !s.trim().is_empty()),
        sftp_username: get(SETTING_SFTP_USERNAME).filter(|s| !s.trim().is_empty()),
        sftp_password_set: get(SETTING_SFTP_PASSWORD)
            .map(|p| !p.trim().is_empty())
            .unwrap_or(false),
        sftp_stats_path: get(SETTING_SFTP_STATS_PATH).filter(|s| !s.trim().is_empty()),
    })
}

async fn get_settings(
    State(state): State<Shared>,
    headers: HeaderMap,
) -> Result<Json<SettingsDto>, ApiError> {
    require_admin(&state, &headers).await?;
    Ok(Json(load_settings_dto(&state).await?))
}

#[derive(Deserialize)]
struct UpdateSettingsRequest {
    #[serde(
        rename = "telegramToken",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    telegram_token: Option<String>,
    #[serde(rename = "sftpHost", default, skip_serializing_if = "Option::is_none")]
    sftp_host: Option<String>,
    #[serde(
        rename = "sftpUsername",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    sftp_username: Option<String>,
    #[serde(
        rename = "sftpPassword",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    sftp_password: Option<String>,
    #[serde(rename = "sftpStatsPath", default, skip_serializing_if = "Option::is_none")]
    sftp_stats_path: Option<String>,
}

/// Сохраняет настройки. Сейчас — токен Telegram-бота: пишем его в таблицу
/// `settings`, откуда сервис `telegram-bot` подхватывает его без рестарта.
/// При смене токена сбрасываем закэшированный username бота — он перечитает
/// его сам через `getMe`.
async fn update_settings(
    State(state): State<Shared>,
    headers: HeaderMap,
    Json(req): Json<UpdateSettingsRequest>,
) -> Result<Json<SettingsDto>, ApiError> {
    require_admin(&state, &headers).await?;

    if let Some(token) = req.telegram_token {
        let token = token.trim();
        if token.is_empty() {
            // Пустая строка — отключить бота (убрать токен и username).
            state
                .store
                .delete_setting(SETTING_TELEGRAM_TOKEN)
                .await
                .map_err(internal)?;
            state
                .store
                .delete_setting(SETTING_TELEGRAM_USERNAME)
                .await
                .map_err(internal)?;
        } else {
            state
                .store
                .set_setting(SETTING_TELEGRAM_TOKEN, token)
                .await
                .map_err(internal)?;
            // Username устарел — пусть бот перечитает его сам.
            state
                .store
                .delete_setting(SETTING_TELEGRAM_USERNAME)
                .await
                .map_err(internal)?;
        }
    }

    // SFTP: sftpHost, sftpUsername, sftpPassword (пустая строка = удалить).
    if let Some(v) = req.sftp_host {
        let v = v.trim();
        if v.is_empty() {
            state
                .store
                .delete_setting(SETTING_SFTP_HOST)
                .await
                .map_err(internal)?;
        } else {
            state
                .store
                .set_setting(SETTING_SFTP_HOST, v)
                .await
                .map_err(internal)?;
        }
    }
    if let Some(v) = req.sftp_username {
        let v = v.trim();
        if v.is_empty() {
            state
                .store
                .delete_setting(SETTING_SFTP_USERNAME)
                .await
                .map_err(internal)?;
        } else {
            state
                .store
                .set_setting(SETTING_SFTP_USERNAME, v)
                .await
                .map_err(internal)?;
        }
    }
    if let Some(v) = req.sftp_password {
        let v = v.trim();
        if v.is_empty() {
            state
                .store
                .delete_setting(SETTING_SFTP_PASSWORD)
                .await
                .map_err(internal)?;
        } else {
            state
                .store
                .set_setting(SETTING_SFTP_PASSWORD, v)
                .await
                .map_err(internal)?;
        }
    }

    if let Some(v) = req.sftp_stats_path {
        let v = v.trim();
        if v.is_empty() {
            state.store.delete_setting(SETTING_SFTP_STATS_PATH).await.map_err(internal)?;
        } else {
            state.store.set_setting(SETTING_SFTP_STATS_PATH, v).await.map_err(internal)?;
        }
    }

    Ok(Json(load_settings_dto(&state).await?))
}

// ───────────────────────── Сборки ─────────────────────────

#[derive(Serialize)]
struct BuildHeaderDto {
    id: i64,
    name: String,
    version: String,
    #[serde(rename = "loaderKind")]
    loader_kind: String,
    #[serde(rename = "mcVersion")]
    mc_version: String,
    #[serde(rename = "loaderVersion")]
    loader_version: String,
    #[serde(rename = "isActive")]
    is_active: bool,
}

impl From<store::BuildHeader> for BuildHeaderDto {
    fn from(h: store::BuildHeader) -> Self {
        Self {
            id: h.id,
            name: h.name,
            version: h.version,
            loader_kind: h.loader_kind,
            mc_version: h.mc_version,
            loader_version: h.loader_version,
            is_active: h.is_active,
        }
    }
}

#[derive(Serialize)]
struct BuildFileDto {
    id: i64,
    path: String,
    sha1: String,
    #[serde(rename = "sizeBytes")]
    size_bytes: i64,
    side: String,
    kind: String,
    overwrite: bool,
    optional: bool,
    #[serde(rename = "enabledByDefault")]
    enabled_by_default: bool,
    disabled: bool,
    #[serde(rename = "modId")]
    mod_id: Option<String>,
    #[serde(rename = "displayName")]
    display_name: Option<String>,
    description: Option<String>,
}

impl From<store::BuildFileRow> for BuildFileDto {
    fn from(f: store::BuildFileRow) -> Self {
        Self {
            id: f.id,
            path: f.path,
            sha1: f.sha1,
            size_bytes: f.size_bytes,
            side: f.side,
            kind: f.kind,
            overwrite: f.overwrite,
            optional: f.optional,
            enabled_by_default: f.enabled_by_default,
            disabled: f.disabled,
            mod_id: f.mod_id,
            display_name: f.display_name,
            description: f.description,
        }
    }
}

#[derive(Serialize)]
struct BuildDetailDto {
    #[serde(flatten)]
    header: BuildHeaderDto,
    files: Vec<BuildFileDto>,
}

async fn list_builds(
    State(state): State<Shared>,
    headers: HeaderMap,
) -> Result<Json<Vec<BuildHeaderDto>>, ApiError> {
    require_admin(&state, &headers).await?;
    let builds = state.store.list_builds().await.map_err(internal)?;
    Ok(Json(builds.into_iter().map(Into::into).collect()))
}

#[derive(Deserialize)]
struct CreateBuildRequest {
    name: String,
    version: String,
    #[serde(rename = "loaderKind", default = "default_loader")]
    loader_kind: String,
    #[serde(rename = "mcVersion")]
    mc_version: String,
    #[serde(rename = "loaderVersion", default)]
    loader_version: String,
}

fn default_loader() -> String {
    "neoforge".to_string()
}

#[derive(Serialize)]
struct CreatedBuild {
    id: i64,
}

async fn create_build(
    State(state): State<Shared>,
    headers: HeaderMap,
    Json(req): Json<CreateBuildRequest>,
) -> Result<Json<CreatedBuild>, ApiError> {
    require_admin(&state, &headers).await?;
    if req.name.trim().is_empty() || req.version.trim().is_empty() {
        return Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            "Имя и версия обязательны",
        ));
    }
    let id = state
        .store
        .create_build(NewBuild {
            name: req.name,
            version: req.version,
            loader_kind: req.loader_kind,
            mc_version: req.mc_version,
            loader_version: req.loader_version,
        })
        .await
        .map_err(internal)?;
    Ok(Json(CreatedBuild { id }))
}

async fn get_build(
    State(state): State<Shared>,
    headers: HeaderMap,
    Path(id): Path<i64>,
) -> Result<Json<BuildDetailDto>, ApiError> {
    require_admin(&state, &headers).await?;
    let record = state
        .store
        .get_build(id)
        .await
        .map_err(internal)?
        .ok_or_else(|| ApiError::new(StatusCode::NOT_FOUND, "Сборка не найдена"))?;
    Ok(Json(BuildDetailDto {
        header: record.header.into(),
        files: record.files.into_iter().map(Into::into).collect(),
    }))
}

async fn delete_build(
    State(state): State<Shared>,
    headers: HeaderMap,
    Path(id): Path<i64>,
) -> Result<StatusCode, ApiError> {
    require_admin(&state, &headers).await?;
    state.store.delete_build(id).await.map_err(map_store)?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize)]
struct UpdateBuildRequest {
    name: String,
    version: String,
    #[serde(rename = "loaderKind", default = "default_loader")]
    loader_kind: String,
    #[serde(rename = "mcVersion")]
    mc_version: String,
    #[serde(rename = "loaderVersion", default)]
    loader_version: String,
}

async fn update_build(
    State(state): State<Shared>,
    headers: HeaderMap,
    Path(id): Path<i64>,
    Json(req): Json<UpdateBuildRequest>,
) -> Result<StatusCode, ApiError> {
    require_admin(&state, &headers).await?;
    if req.name.trim().is_empty() || req.version.trim().is_empty() {
        return Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            "Имя и версия обязательны",
        ));
    }
    state
        .store
        .update_build(
            id,
            store::UpdateBuild {
                name: req.name,
                version: req.version,
                loader_kind: req.loader_kind,
                mc_version: req.mc_version,
                loader_version: req.loader_version,
            },
        )
        .await
        .map_err(map_store)?;
    Ok(StatusCode::NO_CONTENT)
}

async fn activate_build(
    State(state): State<Shared>,
    headers: HeaderMap,
    Path(id): Path<i64>,
) -> Result<StatusCode, ApiError> {
    require_admin(&state, &headers).await?;
    state.store.set_active_build(id).await.map_err(map_store)?;
    Ok(StatusCode::NO_CONTENT)
}

/// Тело запроса клонирования: необязательное имя копии.
#[derive(Deserialize, Default)]
struct CloneBuildRequest {
    #[serde(default)]
    name: Option<String>,
}

/// Клонирует сборку со всеми файлами в новую (неактивную). Имя берётся из
/// тела запроса либо генерируется как «<имя оригинала> (копия)».
async fn clone_build(
    State(state): State<Shared>,
    headers: HeaderMap,
    Path(id): Path<i64>,
    body: Option<Json<CloneBuildRequest>>,
) -> Result<Json<CreatedBuild>, ApiError> {
    require_admin(&state, &headers).await?;

    // Имя копии: явное из запроса (если непустое) или «<оригинал> (копия)».
    let requested = body
        .and_then(|Json(b)| b.name)
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    let new_name = match requested {
        Some(name) => name,
        None => {
            let src = state
                .store
                .get_build(id)
                .await
                .map_err(internal)?
                .ok_or_else(|| ApiError::new(StatusCode::NOT_FOUND, "Сборка не найдена"))?;
            format!("{} (копия)", src.header.name)
        }
    };

    let new_id = state
        .store
        .clone_build(id, &new_name)
        .await
        .map_err(map_store)?;
    Ok(Json(CreatedBuild { id: new_id }))
}

// ───────────────────────── Загрузка файлов ─────────────────────────

/// Принимает multipart: поле `meta` (JSON с метаданными) и поле `file`
/// (содержимое). SHA-1 считаем сами, имя в хранилище = sha1.
async fn upload_file(
    State(state): State<Shared>,
    headers: HeaderMap,
    Path(build_id): Path<i64>,
    mut multipart: Multipart,
) -> Result<Json<BuildFileDto>, ApiError> {
    require_admin(&state, &headers).await?;

    // Убедимся, что сборка существует.
    if state
        .store
        .get_build(build_id)
        .await
        .map_err(internal)?
        .is_none()
    {
        return Err(ApiError::new(StatusCode::NOT_FOUND, "Сборка не найдена"));
    }

    let mut meta: Option<UploadMeta> = None;
    let mut temp_path: Option<std::path::PathBuf> = None;

    while let Some(field) = multipart
        .next_field()
        .await
        .map_err(|e| ApiError::new(StatusCode::BAD_REQUEST, format!("multipart: {e}")))?
    {
        match field.name() {
            Some("meta") => {
                let text = field
                    .text()
                    .await
                    .map_err(|e| ApiError::new(StatusCode::BAD_REQUEST, format!("meta: {e}")))?;
                meta = Some(serde_json::from_str(&text).map_err(|e| {
                    ApiError::new(StatusCode::BAD_REQUEST, format!("meta JSON: {e}"))
                })?);
            }
            Some("file") => {
                // Стримим файл на диск вместо чтения в память.
                let tp = tempfile::NamedTempFile::new_in(&state.modpack_dir)
                    .map_err(|e| internal(format!("temp file: {e}")))?;
                let mut file = tokio::fs::File::create(tp.path())
                    .await
                    .map_err(|e| internal(format!("create temp: {e}")))?;
                let mut stream = field.into_stream();
                use tokio::io::AsyncWriteExt;
                while let Some(chunk) = stream
                    .try_next()
                    .await
                    .map_err(|e| ApiError::new(StatusCode::BAD_REQUEST, format!("file chunk: {e}")))?
                {
                    file.write_all(&chunk)
                        .await
                        .map_err(|e| internal(format!("write chunk: {e}")))?;
                }
                file.flush()
                    .await
                    .map_err(|e| internal(format!("flush: {e}")))?;
                drop(file);
                temp_path = Some(tp.into_temp_path().keep()
                    .map_err(|e| internal(format!("keep temp: {e}")))?);
            }
            _ => {}
        }
    }

    let meta = meta.ok_or_else(|| ApiError::new(StatusCode::BAD_REQUEST, "Нет поля meta"))?;
    let temp_path = temp_path.ok_or_else(|| ApiError::new(StatusCode::BAD_REQUEST, "Нет файла"))?;
    if meta.path.trim().is_empty() {
        tokio::fs::remove_file(&temp_path).await.ok();
        return Err(ApiError::new(StatusCode::BAD_REQUEST, "Пустой path"));
    }

    // Вычисляем SHA-1 и размер из уже записанного файла на диске.
    let bytes = tokio::fs::read(&temp_path)
        .await
        .map_err(|e| internal(format!("read temp: {e}")))?;
    let size_bytes = bytes.len() as i64;
    let sha1 = sha1_hex(&bytes);
    drop(bytes); // освобождаем память сразу

    // Перемещаем в контент-адресное хранилище (одинаковые файлы не дублируются).
    let dest = state.modpack_dir.join(&sha1);
    if dest.exists() {
        tokio::fs::remove_file(&temp_path).await.ok();
    } else {
        tokio::fs::rename(&temp_path, &dest)
            .await
            .map_err(|e| internal(format!("rename temp: {e}")))?;
    }

    let file = store::BuildFileInput {
        path: meta.path.trim().to_string(),
        sha1: sha1.clone(),
        size_bytes,
        side: meta.side.unwrap_or_else(|| "both".to_string()),
        kind: meta.kind.unwrap_or_else(|| "mod".to_string()),
        overwrite: meta.overwrite.unwrap_or(true),
        optional: meta.optional.unwrap_or(false),
        enabled_by_default: meta.enabled_by_default.unwrap_or(true),
        disabled: false,
        mod_id: meta.mod_id,
        display_name: meta.display_name,
        description: meta.description,
        storage_key: sha1,
    };

    let id = state
        .store
        .upsert_build_file(build_id, file.clone())
        .await
        .map_err(map_store)?;

    Ok(Json(BuildFileDto {
        id,
        path: file.path,
        sha1: file.sha1,
        size_bytes: file.size_bytes,
        side: file.side,
        kind: file.kind,
        overwrite: file.overwrite,
        optional: file.optional,
        enabled_by_default: file.enabled_by_default,
        disabled: file.disabled,
        mod_id: file.mod_id,
        display_name: file.display_name,
        description: file.description,
    }))
}

#[derive(Deserialize)]
struct UploadMeta {
    /// Путь относительно `.minecraft` (напр. `mods/sodium.jar`).
    path: String,
    side: Option<String>,
    kind: Option<String>,
    overwrite: Option<bool>,
    optional: Option<bool>,
    #[serde(rename = "enabledByDefault")]
    enabled_by_default: Option<bool>,
    #[serde(rename = "modId")]
    mod_id: Option<String>,
    #[serde(rename = "displayName")]
    display_name: Option<String>,
    description: Option<String>,
}

#[derive(Deserialize)]
struct UpdateFileMeta {
    side: Option<String>,
    kind: Option<String>,
    overwrite: Option<bool>,
    optional: Option<bool>,
    #[serde(rename = "enabledByDefault")]
    enabled_by_default: Option<bool>,
    disabled: Option<bool>,
    #[serde(rename = "modId")]
    mod_id: Option<String>,
    #[serde(rename = "displayName")]
    display_name: Option<String>,
    description: Option<String>,
}

/// Частичное обновление метаданных файла (сторона, опциональность и т.д.).
/// Содержимое и путь файла не меняются.
async fn update_file(
    State(state): State<Shared>,
    headers: HeaderMap,
    Path(file_id): Path<i64>,
    Json(patch): Json<UpdateFileMeta>,
) -> Result<Json<BuildFileDto>, ApiError> {
    require_admin(&state, &headers).await?;

    // Берём текущую строку, чтобы неуказанные поля остались прежними.
    let current = state.store.build_file(file_id).await.map_err(map_store)?;

    let meta = store::BuildFileMeta {
        side: patch.side.unwrap_or(current.side),
        kind: patch.kind.unwrap_or(current.kind),
        overwrite: patch.overwrite.unwrap_or(current.overwrite),
        optional: patch.optional.unwrap_or(current.optional),
        enabled_by_default: patch
            .enabled_by_default
            .unwrap_or(current.enabled_by_default),
        disabled: patch.disabled.unwrap_or(current.disabled),
        mod_id: patch.mod_id.or(current.mod_id),
        display_name: patch.display_name.or(current.display_name),
        description: patch.description.or(current.description),
    };

    let row = state
        .store
        .update_build_file_meta(file_id, meta)
        .await
        .map_err(map_store)?;

    Ok(Json(BuildFileDto::from(row)))
}

#[derive(Deserialize)]
struct UpdateContent {
    content: String,
}

/// Заменяет содержимое текстового файла. Пересчитывает sha1, пишет новые
/// байты в контент-адресное хранилище и обновляет строку. Путь не меняется.
async fn update_file_content(
    State(state): State<Shared>,
    headers: HeaderMap,
    Path(file_id): Path<i64>,
    Json(body): Json<UpdateContent>,
) -> Result<Json<BuildFileDto>, ApiError> {
    require_admin(&state, &headers).await?;

    state.store.build_file(file_id).await.map_err(map_store)?;

    let bytes = body.content.into_bytes();
    let sha1 = sha1_hex(&bytes);
    let size_bytes = bytes.len() as i64;

    let dest = state.modpack_dir.join(&sha1);
    if !dest.exists() {
        tokio::fs::write(&dest, &bytes)
            .await
            .map_err(|e| internal(format!("запись файла: {e}")))?;
    }

    let row = state
        .store
        .update_build_file_content(file_id, sha1.clone(), size_bytes, sha1)
        .await
        .map_err(map_store)?;

    Ok(Json(BuildFileDto::from(row)))
}

async fn delete_file(
    State(state): State<Shared>,
    headers: HeaderMap,
    Path(file_id): Path<i64>,
) -> Result<StatusCode, ApiError> {
    require_admin(&state, &headers).await?;
    state
        .store
        .delete_build_file(file_id)
        .await
        .map_err(map_store)?;
    Ok(StatusCode::NO_CONTENT)
}

// ───────────────────────── Синхронизация по SFTP ─────────────────────────

#[derive(Serialize)]
struct SyncResult {
    uploaded: usize,
    skipped: usize,
    deleted: usize,
    #[serde(rename = "inProgress")]
    in_progress: bool,
}

#[derive(Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct SyncStatus {
    build_id: Option<i64>,
    state: SyncState,
    phase: String,
    current: usize,
    total: usize,
    uploaded: usize,
    skipped: usize,
    deleted: usize,
    error: Option<String>,
    started_at: Option<String>,
    finished_at: Option<String>,
}

#[derive(Clone, Default, Serialize)]
#[serde(rename_all = "snake_case")]
enum SyncState {
    #[default]
    Idle,
    Running,
    Success,
    Error,
}

impl SyncStatus {
    fn started(build_id: i64) -> Self {
        Self {
            build_id: Some(build_id),
            state: SyncState::Running,
            phase: "Подготовка".to_string(),
            started_at: Some(OffsetDateTime::now_utc().format(&Rfc3339).unwrap_or_default()),
            ..Self::default()
        }
    }
}

async fn update_sync_status(state: &Shared, update: impl FnOnce(&mut SyncStatus)) {
    let mut status = state.sync_to_panel_status.lock().await;
    update(&mut status);
}

/// Имя манифеста синхронизации на стороне сервера. По нему при следующей
/// синхронизации мы понимаем, какие файлы заливали раньше, и удаляем те,
/// что были убраны из сборки (как `managed-files.json` в лаунчере).
const SYNC_MANIFEST: &str = ".stardust-sync.json";

/// SSH client handler. Хранит known hosts в файле `known_hosts.json` рядом с
/// modpack-dir. При первом подключении ключ хоста сохраняется; при последующих
/// — проверяется. Если файл отсутствует или пуст — ключ принимается и
/// записывается (первое подключение = доверие). Смена ключа хоста = ошибка
/// (возможная MITM-атака).
struct SftpHandler {
    /// Путь к файлу known_hosts.json.
    known_hosts_path: std::path::PathBuf,
}

impl SftpHandler {
    fn new(modpack_dir: &std::path::Path) -> Self {
        Self {
            known_hosts_path: modpack_dir.join("known_hosts.json"),
        }
    }

    /// Читает known hosts из файла.
    fn load_hosts(&self) -> std::collections::BTreeMap<String, String> {
        std::fs::read_to_string(&self.known_hosts_path)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default()
    }

    /// Сохраняет known hosts в файл.
    fn save_hosts(&self, hosts: &std::collections::BTreeMap<String, String>) {
        if let Ok(json) = serde_json::to_string_pretty(hosts) {
            let _ = std::fs::write(&self.known_hosts_path, json);
        }
    }
}

impl russh::client::Handler for SftpHandler {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        key: &russh::keys::ssh_key::PublicKey,
    ) -> Result<bool, Self::Error> {
        // Fingerprint ключа для сравнения (стабильный формат).
        let key_str = key
            .fingerprint(russh::keys::ssh_key::HashAlg::Sha256)
            .to_string();

        // Проверяем known hosts.
        let mut hosts = self.load_hosts();
        let host_key = hosts.get("host_key");

        match host_key {
            Some(known) if known == &key_str => {
                // Ключ совпал — хост известен и доверен.
                Ok(true)
            }
            Some(_mismatch) => {
                // Ключ изменился — потенциальная MITM-атака.
                tracing::error!(
                    "[sftp] КЛЮЧ ХОСТА ИЗМЕНИЛСЯ! Возможна MITM-атака. \
                     Удалите known_hosts.json и подключитесь заново, \
                     если вы уверены в безопасности канала."
                );
                Err(russh::Error::UnknownKey)
            }
            None => {
                // Первое подключение — сохраняем ключ.
                tracing::info!("[sftp] Первое подключение, сохраняем ключ хоста");
                hosts.insert("host_key".to_string(), key_str);
                self.save_hosts(&hosts);
                Ok(true)
            }
        }
    }
}

async fn sync_to_panel(
    State(state): State<Shared>,
    headers: HeaderMap,
    Path(build_id): Path<i64>,
) -> Result<(StatusCode, Json<SyncResult>), ApiError> {
    require_admin(&state, &headers).await?;

    {
        let mut running = state.sync_to_panel_running.lock().await;
        if let Some(active_build_id) = *running {
            return Err(ApiError::new(
                StatusCode::CONFLICT,
                format!("SFTP-синхронизация уже выполняется для сборки #{active_build_id}"),
            ));
        }
        *running = Some(build_id);
    }
    update_sync_status(&state, |status| *status = SyncStatus::started(build_id)).await;

    let task_state = Arc::clone(&state);
    tokio::spawn(async move {
        match do_sync_to_panel(Arc::clone(&task_state), build_id).await {
            Ok(result) => {
                update_sync_status(&task_state, |status| {
                    status.state = SyncState::Success;
                    status.phase = "Готово".to_string();
                    status.current = status.total;
                    status.uploaded = result.uploaded;
                    status.skipped = result.skipped;
                    status.deleted = result.deleted;
                    status.error = None;
                    status.finished_at = Some(OffsetDateTime::now_utc().format(&Rfc3339).unwrap_or_default());
                })
                .await;
                tracing::info!(
                    build_id,
                    uploaded = result.uploaded,
                    skipped = result.skipped,
                    deleted = result.deleted,
                    "[sftp] синхронизация завершена"
                );
            }
            Err(err) => {
                update_sync_status(&task_state, |status| {
                    status.state = SyncState::Error;
                    status.phase = "Ошибка".to_string();
                    status.error = Some(err.message.clone());
                    status.finished_at = Some(OffsetDateTime::now_utc().format(&Rfc3339).unwrap_or_default());
                })
                .await;
                tracing::error!(
                    build_id,
                    status = %err.status,
                    error = %err.message,
                    "[sftp] синхронизация завершилась ошибкой"
                );
            }
        }

        let mut running = task_state.sync_to_panel_running.lock().await;
        if *running == Some(build_id) {
            *running = None;
        }
    });

    Ok((
        StatusCode::ACCEPTED,
        Json(SyncResult {
            uploaded: 0,
            skipped: 0,
            deleted: 0,
            in_progress: true,
        }),
    ))
}

async fn sync_to_panel_status(
    State(state): State<Shared>,
    headers: HeaderMap,
    Path(build_id): Path<i64>,
) -> Result<Json<SyncStatus>, ApiError> {
    require_admin(&state, &headers).await?;
    let status = state.sync_to_panel_status.lock().await.clone();
    if status.build_id == Some(build_id) {
        Ok(Json(status))
    } else {
        Ok(Json(SyncStatus::default()))
    }
}

async fn do_sync_to_panel(state: Shared, build_id: i64) -> Result<SyncResult, ApiError> {
    let host = state
        .store
        .get_setting(SETTING_SFTP_HOST)
        .await
        .map_err(internal)?
        .filter(|s| !s.trim().is_empty())
        .ok_or_else(|| ApiError::new(StatusCode::BAD_REQUEST, "sftpHost не задан"))?;
    let username = state
        .store
        .get_setting(SETTING_SFTP_USERNAME)
        .await
        .map_err(internal)?
        .filter(|s| !s.trim().is_empty())
        .ok_or_else(|| ApiError::new(StatusCode::BAD_REQUEST, "sftpUsername не задан"))?;
    let password = state
        .store
        .get_setting(SETTING_SFTP_PASSWORD)
        .await
        .map_err(internal)?
        .filter(|s| !s.trim().is_empty())
        .ok_or_else(|| ApiError::new(StatusCode::BAD_REQUEST, "sftpPassword не задан"))?;

    let build = state
        .store
        .get_build(build_id)
        .await
        .map_err(internal)?
        .ok_or_else(|| ApiError::new(StatusCode::NOT_FOUND, "сборка не найдена"))?;

    // host или host:port → нормализуем в (host, port).
    let (host_part, port) = match host.rsplit_once(':') {
        Some((h, p)) => match p.parse::<u16>() {
            Ok(port) => (h.to_string(), port),
            // двоеточие без числа (например, IPv6 без порта) — берём как есть.
            Err(_) => (host.clone(), 22),
        },
        None => (host.clone(), 22),
    };

    // Устанавливаем SSH-сессию и аутентифицируемся паролем.
    let config = Arc::new(russh::client::Config::default());
    let mut session = russh::client::connect(config, (host_part.as_str(), port), SftpHandler::new(&state.modpack_dir))
        .await
        .map_err(|e| internal(format!("SSH-подключение к {host_part}:{port}: {e}")))?;
    let auth = session
        .authenticate_password(&username, &password)
        .await
        .map_err(|e| internal(format!("SSH-аутентификация: {e}")))?;
    if !auth.success() {
        return Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            "SFTP-аутентификация не прошла: проверьте логин/пароль",
        ));
    }

    let channel = session
        .channel_open_session()
        .await
        .map_err(|e| internal(format!("открытие канала: {e}")))?;
    channel
        .request_subsystem(true, "sftp")
        .await
        .map_err(|e| internal(format!("запуск sftp-подсистемы: {e}")))?;
    let sftp = russh_sftp::client::SftpSession::new(channel.into_stream())
        .await
        .map_err(|e| internal(format!("инициализация SFTP: {e}")))?;

    // Манифест прошлой синхронизации: { путь -> sha1 } того, что мы заливали.
    // По нему удаляем файлы, убранные из сборки. Если файла нет/он битый —
    // считаем, что синхронизаций ещё не было.
    let previous: std::collections::BTreeMap<String, String> = match sftp.read(SYNC_MANIFEST).await
    {
        Ok(bytes) => serde_json::from_slice(&bytes).unwrap_or_default(),
        Err(_) => std::collections::BTreeMap::new(),
    };

    let mut uploaded = 0usize;
    let mut skipped = 0usize;
    let mut deleted = 0usize;
    let mut current = 0usize;
    let total = build.files.len() + previous.len() + 1;
    update_sync_status(&state, |status| {
        status.phase = "Загрузка файлов".to_string();
        status.current = 0;
        status.total = total.max(1);
    })
    .await;
    // Что должно лежать на сервере после этой синхронизации: { путь -> sha1 }.
    let mut desired: std::collections::BTreeMap<String, String> = std::collections::BTreeMap::new();

    for file in &build.files {
        update_sync_status(&state, |status| {
            status.phase = format!("Загрузка {}", file.path);
            status.current = current;
            status.total = total.max(1);
            status.uploaded = uploaded;
            status.skipped = skipped;
            status.deleted = deleted;
        })
        .await;

        // Грузим всё, что нужно серверу (side = server | both), независимо от
        // опциональности и «включён по умолчанию» — опц. моды тоже едут.
        // Отключённые файлы пропускаем — они не должны отдаваться ни клиенту, ни серверу.
        if file.disabled || (file.side != "server" && file.side != "both") {
            skipped += 1;
            current += 1;
            continue;
        }

        // Целевой путь на сервере = относительный путь файла из сборки.
        let target = file.path.trim_start_matches('/').to_string();

        // ─── Skip unchanged: если файл в манифесте с тем же SHA-1 и
        // удалённый файл существует — пропускаем загрузку. ───
        if let Some(prev_sha1) = previous.get(&target) {
            if prev_sha1.eq_ignore_ascii_case(&file.sha1) {
                // Проверяем, что файл реально есть на сервере.
                match sftp.metadata(&target).await {
                    Ok(_meta) => {
                        // Файл на месте и хеш совпадает — пропускаем.
                        desired.insert(target, file.sha1.clone());
                        skipped += 1;
                        current += 1;
                        continue;
                    }
                    Err(_) => {
                        // Файла нет на сервере (удалён вручную) — перезаливаем.
                    }
                }
            }
        }

        // Создаём родительские директории по цепочке.
        if let Some(parent) = std::path::Path::new(&target).parent() {
            let mut acc = String::new();
            for comp in parent.components() {
                let comp = comp.as_os_str().to_string_lossy();
                if comp.is_empty() {
                    continue;
                }
                if !acc.is_empty() {
                    acc.push('/');
                }
                acc.push_str(&comp);
                // Игнорируем ошибку «уже существует».
                let _ = sftp.create_dir(&acc).await;
            }
        }

        // Читаем файл с диска и заливаем.
        let file_path = state.modpack_dir.join(&file.storage_key);
        let bytes = tokio::fs::read(&file_path)
            .await
            .map_err(|e| internal(format!("чтение файла {}: {e}", file.path)))?;

        write_sftp_file_atomic(&sftp, &target, &bytes).await?;

        desired.insert(target, file.sha1.clone());
        uploaded += 1;
        current += 1;
    }

    // Удаляем то, что заливали раньше, но в текущей сборке этого уже нет.
    // Удаляем только если содержимое на сервере не менялось с момента нашей
    // заливки (sha1 совпадает с записанным) — чтобы не затирать правки админа
    // сервера. Сам манифест синхронизации не трогаем.
    for (path, recorded_sha1) in &previous {
        update_sync_status(&state, |status| {
            status.phase = format!("Проверка удаления {path}");
            status.current = current;
            status.total = total.max(1);
            status.uploaded = uploaded;
            status.skipped = skipped;
            status.deleted = deleted;
        })
        .await;

        if desired.contains_key(path) || path == SYNC_MANIFEST {
            current += 1;
            continue;
        }
        let unchanged = match sftp.read(path).await {
            Ok(bytes) => sha1_hex(&bytes).eq_ignore_ascii_case(recorded_sha1),
            // Файла уже нет на сервере — удалять нечего.
            Err(_) => false,
        };
        if unchanged && sftp.remove_file(path).await.is_ok() {
            deleted += 1;
        }
        current += 1;
    }

    // Сохраняем новый манифест синхронизации на сервере.
    update_sync_status(&state, |status| {
        status.phase = "Запись манифеста".to_string();
        status.current = current;
        status.total = total.max(1);
        status.uploaded = uploaded;
        status.skipped = skipped;
        status.deleted = deleted;
    })
    .await;
    let manifest_bytes = serde_json::to_vec(&desired)
        .map_err(|e| internal(format!("сериализация манифеста: {e}")))?;
    write_sftp_file_atomic(&sftp, SYNC_MANIFEST, &manifest_bytes).await?;
    current += 1;
    update_sync_status(&state, |status| {
        status.current = current;
        status.total = total.max(1);
        status.uploaded = uploaded;
        status.skipped = skipped;
        status.deleted = deleted;
    })
    .await;

    // Корректно завершаем SSH-сессию.
    let _ = session
        .disconnect(russh::Disconnect::ByApplication, "", "en")
        .await;

    Ok(SyncResult {
        uploaded,
        skipped,
        deleted,
        in_progress: false,
    })
}

async fn write_sftp_file_atomic(
    sftp: &russh_sftp::client::SftpSession,
    target: &str,
    bytes: &[u8],
) -> Result<(), ApiError> {
    use russh_sftp::protocol::OpenFlags;
    use tokio::io::AsyncWriteExt;

    let tmp = format!(
        "{target}.stardust-upload-{}-{}.tmp",
        std::process::id(),
        OffsetDateTime::now_utc().unix_timestamp_nanos()
    );

    let write_result = async {
        let mut remote = sftp
            .open_with_flags(&tmp, OpenFlags::CREATE | OpenFlags::WRITE | OpenFlags::TRUNCATE)
            .await
            .map_err(|e| internal(format!("открытие временного файла {tmp} на сервере: {e}")))?;

        // SFTP-серверы часто ограничивают размер WRITE-пакета примерно 32 КБ.
        const SFTP_CHUNK: usize = 30 * 1024;
        for chunk in bytes.chunks(SFTP_CHUNK) {
            remote
                .write_all(chunk)
                .await
                .map_err(|e| internal(format!("запись временного файла {tmp}: {e}")))?;
        }
        remote
            .shutdown()
            .await
            .map_err(|e| internal(format!("закрытие временного файла {tmp}: {e}")))?;

        Ok::<(), ApiError>(())
    }
    .await;

    if let Err(err) = write_result {
        let _ = sftp.remove_file(&tmp).await;
        return Err(err);
    }

    if let Err(first_err) = sftp.rename(&tmp, target).await {
        // Некоторые SFTP-серверы не заменяют существующий файл через rename.
        // Временный файл уже полностью записан, поэтому целевой путь трогаем
        // только перед финальным rename, а не в начале загрузки.
        let _ = sftp.remove_file(target).await;
        if let Err(second_err) = sftp.rename(&tmp, target).await {
            let _ = sftp.remove_file(&tmp).await;
            return Err(internal(format!(
                "атомарная замена {target}: {first_err}; повтор после удаления: {second_err}"
            )));
        }
    }

    Ok(())
}

// ───────────────────────── Деплой мода ─────────────────────────

#[derive(Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct DeployModStatus {
    state: SyncState,
    phase: String,
    version: Option<String>,
    error: Option<String>,
    started_at: Option<String>,
    finished_at: Option<String>,
}

#[derive(Deserialize)]
struct GitHubRelease {
    tag_name: String,
    assets: Vec<GitHubAsset>,
}

#[derive(Deserialize)]
struct GitHubAsset {
    name: String,
    browser_download_url: String,
}

async fn deploy_mod(
    State(state): State<Shared>,
    headers: HeaderMap,
) -> Result<(StatusCode, Json<serde_json::Value>), ApiError> {
    require_admin(&state, &headers).await?;

    {
        let mut running = state.deploy_mod_running.lock().await;
        if *running {
            return Err(ApiError::new(
                StatusCode::CONFLICT,
                "Деплой мода уже выполняется",
            ));
        }
        *running = true;
    }

    update_deploy_mod_status(&state, |status| {
        *status = DeployModStatus {
            state: SyncState::Running,
            phase: "Подготовка".to_string(),
            started_at: Some(OffsetDateTime::now_utc().format(&Rfc3339).unwrap_or_default()),
            ..Default::default()
        };
    })
    .await;

    let task_state = Arc::clone(&state);
    tokio::spawn(async move {
        match do_deploy_mod(Arc::clone(&task_state)).await {
            Ok(version) => {
                update_deploy_mod_status(&task_state, |status| {
                    status.state = SyncState::Success;
                    status.phase = "Готово".to_string();
                    status.version = Some(version);
                    status.finished_at =
                        Some(OffsetDateTime::now_utc().format(&Rfc3339).unwrap_or_default());
                })
                .await;
            }
            Err(e) => {
                let msg = e.message.clone();
                tracing::warn!("deploy-mod: ошибка: {}", msg);
                update_deploy_mod_status(&task_state, |status| {
                    status.state = SyncState::Error;
                    status.phase = "Ошибка".to_string();
                    status.error = Some(msg);
                    status.finished_at =
                        Some(OffsetDateTime::now_utc().format(&Rfc3339).unwrap_or_default());
                })
                .await;
            }
        }
        *task_state.deploy_mod_running.lock().await = false;
    });

    Ok((StatusCode::ACCEPTED, Json(serde_json::json!({ "inProgress": true }))))
}

async fn deploy_mod_status(
    State(state): State<Shared>,
    headers: HeaderMap,
) -> Result<Json<DeployModStatus>, ApiError> {
    require_admin(&state, &headers).await?;
    let status = state.deploy_mod_status.lock().await.clone();
    Ok(Json(status))
}

async fn update_deploy_mod_status(state: &Shared, update: impl FnOnce(&mut DeployModStatus)) {
    let mut status = state.deploy_mod_status.lock().await;
    update(&mut status);
}

async fn do_deploy_mod(state: Shared) -> Result<String, ApiError> {
    // 1. Получаем последний релиз мода из GitHub API.
    update_deploy_mod_status(&state, |s| s.phase = "Запрос к GitHub API".to_string()).await;

    let release: GitHubRelease = {
        let releases_url = "https://api.github.com/repos/Zeragorn-ru/stardust/releases?per_page=10";
        let resp = state
            .http
            .get(releases_url)
            .header("Accept", "application/vnd.github.v3+json")
            .send()
            .await
            .map_err(|e| internal(format!("запрос списка релизов: {e}")))?;

        let releases: Vec<GitHubRelease> = resp
            .json()
            .await
            .map_err(|e| internal(format!("парсинг списка релизов: {e}")))?;

        releases
            .into_iter()
            .find(|r| r.tag_name.starts_with("mod-v"))
            .ok_or_else(|| ApiError::new(StatusCode::NOT_FOUND, "Релизы мода (mod-v*) не найдены"))?
    };

    let version = release
        .tag_name
        .strip_prefix("mod-v")
        .unwrap_or(&release.tag_name)
        .to_string();

    update_deploy_mod_status(&state, |s| {
        s.phase = format!("Релиз: {}", release.tag_name);
        s.version = Some(version.clone());
    })
    .await;

    // 2. Скачиваем jar-файл.
    let jar_asset = release
        .assets
        .iter()
        .find(|a| a.name.ends_with(".jar") && !a.name.ends_with("-sources.jar"))
        .ok_or_else(|| {
            ApiError::new(
                StatusCode::NOT_FOUND,
                format!("jar-файл не найден в релизе {}", release.tag_name),
            )
        })?;

    update_deploy_mod_status(&state, |s| {
        s.phase = format!("Скачивание {}", jar_asset.name);
    })
    .await;

    let jar_bytes = state
        .http
        .get(&jar_asset.browser_download_url)
        .send()
        .await
        .map_err(|e| internal(format!("скачивание jar: {e}")))?
        .bytes()
        .await
        .map_err(|e| internal(format!("чтение jar: {e}")))?
        .to_vec();

    let size_bytes = jar_bytes.len() as i64;
    let sha1 = sha1_hex(&jar_bytes);

    tracing::info!(
        "deploy-mod: скачан {} ({} байт, sha1={})",
        jar_asset.name,
        size_bytes,
        sha1
    );

    // 3. Сохраняем jar в контент-адресное хранилище (modpack_dir/sha1).
    update_deploy_mod_status(&state, |s| {
        s.phase = "Сохранение в хранилище".to_string();
    })
    .await;

    let dest = state.modpack_dir.join(&sha1);
    if !dest.exists() {
        tokio::fs::write(&dest, &jar_bytes)
            .await
            .map_err(|e| internal(format!("запись jar в хранилище: {e}")))?;
    }

    // 4. Добавляем/обновляем файл в активной сборке.
    update_deploy_mod_status(&state, |s| {
        s.phase = "Добавление в сборку".to_string();
    })
    .await;

    let build = state
        .store
        .active_build()
        .await
        .map_err(internal)?
        .ok_or_else(|| ApiError::new(StatusCode::NOT_FOUND, "Нет активной сборки"))?;

    // 4.1 Сохраняем настройки стороны и т.д. из старого мода и удаляем его из сборки.
    let mut old_side = "server".to_string();
    let mut old_overwrite = true;
    let mut old_optional = false;
    let mut old_enabled_by_default = true;
    let mut old_disabled = false;
    let mut old_files_to_delete = Vec::new();

    for f in &build.files {
        let is_stardust_mod = f.mod_id.as_deref() == Some("stardust")
            || (f.path.starts_with("mods/") && f.path.contains("stardust") && f.path.ends_with(".jar"));
        if is_stardust_mod {
            old_side = f.side.clone();
            old_overwrite = f.overwrite;
            old_optional = f.optional;
            old_enabled_by_default = f.enabled_by_default;
            old_disabled = f.disabled;
            old_files_to_delete.push(f.id);
        }
    }

    for file_id in old_files_to_delete {
        state.store.delete_build_file(file_id).await.map_err(map_store)?;
    }

    let file_path = format!("mods/{}", jar_asset.name);

    let file_input = store::BuildFileInput {
        path: file_path.clone(),
        sha1: sha1.clone(),
        size_bytes,
        side: old_side,
        kind: "mod".to_string(),
        overwrite: old_overwrite,
        optional: old_optional,
        enabled_by_default: old_enabled_by_default,
        disabled: old_disabled,
        mod_id: Some("stardust".to_string()),
        display_name: Some("Stardust Mod".to_string()),
        description: Some(format!("Stardust server mod {version}")),
        storage_key: sha1.clone(),
    };

    state
        .store
        .upsert_build_file(build.header.id, file_input)
        .await
        .map_err(map_store)?;

    tracing::info!(
        "deploy-mod: {} добавлен в сборку #{} (путь: {})",
        jar_asset.name,
        build.header.id,
        file_path
    );

    Ok(version)
}

// ───────────────────────── Аккаунты ─────────────────────────

#[derive(Serialize)]
struct AccountDto {
    uuid: String,
    username: String,
    #[serde(rename = "isAdmin")]
    is_admin: bool,
    banned: bool,
    #[serde(rename = "bannedUntil", skip_serializing_if = "Option::is_none")]
    banned_until: Option<String>,
    #[serde(rename = "banReason", skip_serializing_if = "Option::is_none")]
    ban_reason: Option<String>,
    /// Привязан ли Telegram (для значка в таблице).
    #[serde(rename = "telegramLinked")]
    telegram_linked: bool,
    /// Telegram chat_id, если привязан (виден только админу).
    #[serde(rename = "telegramChatId", skip_serializing_if = "Option::is_none")]
    telegram_chat_id: Option<String>,
}

impl From<store::Account> for AccountDto {
    fn from(a: store::Account) -> Self {
        let is_admin = a.is_admin();
        let telegram_chat_id = a.telegram_chat_id.clone();
        let telegram_linked = telegram_chat_id.is_some();
        let (banned, banned_until, ban_reason) = match a.ban {
            Some(ban) => (
                true,
                ban.until
                    .map(|u| u.format(&Rfc3339).unwrap_or_else(|_| u.to_string())),
                ban.reason,
            ),
            None => (false, None, None),
        };
        AccountDto {
            uuid: a.uuid,
            username: a.username,
            is_admin,
            banned,
            banned_until,
            ban_reason,
            telegram_linked,
            telegram_chat_id,
        }
    }
}

async fn list_accounts(
    State(state): State<Shared>,
    headers: HeaderMap,
) -> Result<Json<Vec<AccountDto>>, ApiError> {
    require_admin(&state, &headers).await?;
    let accounts = state.store.all_accounts().await.map_err(internal)?;
    Ok(Json(accounts.into_iter().map(AccountDto::from).collect()))
}

#[derive(Deserialize)]
struct UpdateAccountRequest {
    /// Новый ник (опционально).
    username: Option<String>,
}

/// Редактирование аккаунта админом (пока — переименование).
async fn update_account(
    State(state): State<Shared>,
    headers: HeaderMap,
    Path(uuid): Path<String>,
    Json(req): Json<UpdateAccountRequest>,
) -> Result<Json<AccountDto>, ApiError> {
    require_admin(&state, &headers).await?;
    if let Some(username) = req
        .username
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        state
            .store
            .rename(&uuid, username)
            .await
            .map_err(map_store)?;
    }
    let account = state
        .store
        .find_by_uuid(&uuid)
        .await
        .ok_or_else(|| ApiError::new(StatusCode::NOT_FOUND, "Аккаунт не найден"))?;
    Ok(Json(AccountDto::from(account)))
}

/// Удаление аккаунта админом.
async fn delete_account_admin(
    State(state): State<Shared>,
    headers: HeaderMap,
    Path(uuid): Path<String>,
) -> Result<StatusCode, ApiError> {
    let admin = require_admin(&state, &headers).await?;
    if normalize_for_compare(&admin.uuid) == normalize_for_compare(&uuid) {
        return Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            "Нельзя удалить свой собственный аккаунт",
        ));
    }
    state.store.delete_account(&uuid).await.map_err(map_store)?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize)]
struct BanRequest {
    /// Длительность бана в секундах. `None`/0 — бан навсегда.
    #[serde(rename = "durationSecs")]
    duration_secs: Option<i64>,
    reason: Option<String>,
}

/// Блокировка аккаунта админом.
async fn ban_account(
    State(state): State<Shared>,
    headers: HeaderMap,
    Path(uuid): Path<String>,
    Json(req): Json<BanRequest>,
) -> Result<Json<AccountDto>, ApiError> {
    let admin = require_admin(&state, &headers).await?;
    if normalize_for_compare(&admin.uuid) == normalize_for_compare(&uuid) {
        return Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            "Нельзя забанить свой собственный аккаунт",
        ));
    }
    let until = match req.duration_secs {
        Some(secs) if secs > 0 => {
            Some(OffsetDateTime::now_utc() + Duration::from_secs(secs as u64))
        }
        _ => None,
    };
    let reason = req
        .reason
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty());
    state
        .store
        .ban_account(&uuid, until, reason)
        .await
        .map_err(map_store)?;
    let account = state
        .store
        .find_by_uuid(&uuid)
        .await
        .ok_or_else(|| ApiError::new(StatusCode::NOT_FOUND, "Аккаунт не найден"))?;
    Ok(Json(AccountDto::from(account)))
}

/// Снятие блокировки админом.
async fn unban_account(
    State(state): State<Shared>,
    headers: HeaderMap,
    Path(uuid): Path<String>,
) -> Result<Json<AccountDto>, ApiError> {
    require_admin(&state, &headers).await?;
    state.store.unban_account(&uuid).await.map_err(map_store)?;
    let account = state
        .store
        .find_by_uuid(&uuid)
        .await
        .ok_or_else(|| ApiError::new(StatusCode::NOT_FOUND, "Аккаунт не найден"))?;
    Ok(Json(AccountDto::from(account)))
}

#[derive(Deserialize)]
struct SetRoleRequest {
    /// Целевая роль: `admin` или `user`.
    role: String,
}

/// Смена роли аккаунта админом (выдать/снять права администратора).
///
/// Закрывает функциональный пробел: до этого первого админа можно было выдать
/// только через `ADMIN_BOOTSTRAP`. Запрещает снимать права с самого себя,
/// чтобы админ случайно не заблокировал себе доступ в панель.
async fn set_account_role(
    State(state): State<Shared>,
    headers: HeaderMap,
    Path(uuid): Path<String>,
    Json(req): Json<SetRoleRequest>,
) -> Result<Json<AccountDto>, ApiError> {
    let admin = require_admin(&state, &headers).await?;
    let role = match req.role.trim().to_lowercase().as_str() {
        "admin" => Role::Admin,
        "user" => Role::User,
        other => {
            return Err(ApiError::new(
                StatusCode::BAD_REQUEST,
                format!("Неизвестная роль: {other}"),
            ))
        }
    };
    if role == Role::User && normalize_for_compare(&admin.uuid) == normalize_for_compare(&uuid) {
        return Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            "Нельзя снять права администратора с самого себя",
        ));
    }
    state.store.set_role(&uuid, role).await.map_err(map_store)?;
    let account = state
        .store
        .find_by_uuid(&uuid)
        .await
        .ok_or_else(|| ApiError::new(StatusCode::NOT_FOUND, "Аккаунт не найден"))?;
    Ok(Json(AccountDto::from(account)))
}

#[derive(Deserialize)]
struct SetPasswordRequest {
    password: String,
}

/// Сброс пароля аккаунта админом. Старый пароль не требуется; активные сессии
/// пользователя сбрасываются (старые токены протухают). Полезно, когда игрок
/// забыл пароль и не может восстановить его через Telegram.
async fn set_account_password(
    State(state): State<Shared>,
    headers: HeaderMap,
    Path(uuid): Path<String>,
    Json(req): Json<SetPasswordRequest>,
) -> Result<StatusCode, ApiError> {
    require_admin(&state, &headers).await?;
    let password = req.password;
    if password.len() < 6 {
        return Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            "Пароль должен быть не короче 6 символов",
        ));
    }
    state
        .store
        .set_password(&uuid, &password)
        .await
        .map_err(map_store)?;
    Ok(StatusCode::NO_CONTENT)
}

/// Отвязывает Telegram от аккаунта (админ). Снимает 2FA/passwordless для
/// пользователя — например, если он потерял доступ к своему Telegram.
async fn unlink_account_telegram(
    State(state): State<Shared>,
    headers: HeaderMap,
    Path(uuid): Path<String>,
) -> Result<Json<AccountDto>, ApiError> {
    require_admin(&state, &headers).await?;
    state
        .store
        .set_telegram(&uuid, None)
        .await
        .map_err(map_store)?;
    let account = state
        .store
        .find_by_uuid(&uuid)
        .await
        .ok_or_else(|| ApiError::new(StatusCode::NOT_FOUND, "Аккаунт не найден"))?;
    Ok(Json(AccountDto::from(account)))
}

#[derive(Deserialize)]
struct SetTelegramRequest {
    chat_id: Option<String>,
}

async fn set_account_telegram(
    State(state): State<Shared>,
    headers: HeaderMap,
    Path(uuid): Path<String>,
    Json(req): Json<SetTelegramRequest>,
) -> Result<Json<AccountDto>, ApiError> {
    require_admin(&state, &headers).await?;
    state
        .store
        .set_telegram(&uuid, req.chat_id.as_deref())
        .await
        .map_err(map_store)?;
    let account = state
        .store
        .find_by_uuid(&uuid)
        .await
        .ok_or_else(|| ApiError::new(StatusCode::NOT_FOUND, "Аккаунт не найден"))?;
    Ok(Json(AccountDto::from(account)))
}

/// `GET /api/accounts/:uuid/skin` — PNG-скин аккаунта для аватарки в админке.
///
/// Скины хранятся в общем `store` (та же БД, что у auth-server), поэтому
/// отдаём их прямо отсюда — отдельный поход в auth-server не нужен. Модель
/// (`classic`/`slim`) кладём в заголовок `X-Skin-Model`. Если скина нет — 404,
/// фронт показывает буквенный плейсхолдер.
async fn account_skin(
    State(state): State<Shared>,
    headers: HeaderMap,
    Path(uuid): Path<String>,
) -> Result<Response, ApiError> {
    require_admin(&state, &headers).await?;
    let account = state
        .store
        .find_by_uuid(&uuid)
        .await
        .ok_or_else(|| ApiError::new(StatusCode::NOT_FOUND, "Аккаунт не найден"))?;
    let skin = account
        .skin
        .ok_or_else(|| ApiError::new(StatusCode::NOT_FOUND, "Скин не задан"))?;
    let model = match skin.model {
        protocol::SkinModel::Slim => "slim",
        protocol::SkinModel::Classic => "classic",
    };
    Ok((
        StatusCode::OK,
        [
            (header::CONTENT_TYPE, "image/png"),
            (header::CACHE_CONTROL, "no-cache"),
            (header::HeaderName::from_static("x-skin-model"), model),
        ],
        skin.png,
    )
        .into_response())
}

/// Внутренняя логика синхронизации статистики с SFTP.
/// Возвращает количество обновлённых аккаунтов.
async fn do_sync_stats(state: &Shared) -> Result<usize, String> {
    let host = state
        .store
        .get_setting(SETTING_SFTP_HOST)
        .await
        .map_err(|e| format!("{e}"))?
        .filter(|s| !s.trim().is_empty())
        .ok_or_else(|| "sftpHost не задан".to_string())?;
    let username = state
        .store
        .get_setting(SETTING_SFTP_USERNAME)
        .await
        .map_err(|e| format!("{e}"))?
        .filter(|s| !s.trim().is_empty())
        .ok_or_else(|| "sftpUsername не задан".to_string())?;
    let password = state
        .store
        .get_setting(SETTING_SFTP_PASSWORD)
        .await
        .map_err(|e| format!("{e}"))?
        .filter(|s| !s.trim().is_empty())
        .ok_or_else(|| "sftpPassword не задан".to_string())?;
    let stats_path = state
        .store
        .get_setting(SETTING_SFTP_STATS_PATH)
        .await
        .map_err(|e| format!("{e}"))?
        .filter(|s| !s.trim().is_empty())
        .ok_or_else(|| "sftpStatsPath не задан".to_string())?;

    let (host_part, port) = match host.rsplit_once(':') {
        Some((h, p)) => match p.parse::<u16>() {
            Ok(port) => (h.to_string(), port),
            Err(_) => (host.clone(), 22),
        },
        None => (host.clone(), 22),
    };

    let config = Arc::new(russh::client::Config::default());
    let mut session = russh::client::connect(config, (host_part.as_str(), port), SftpHandler::new(&state.modpack_dir))
        .await
        .map_err(|e| format!("SSH-подключение к {host_part}:{port}: {e}"))?;
    let auth = session
        .authenticate_password(&username, &password)
        .await
        .map_err(|e| format!("SSH-аутентификация: {e}"))?;
    if !auth.success() {
        return Err("SFTP-аутентификация не прошла".into());
    }

    let channel = session
        .channel_open_session()
        .await
        .map_err(|e| format!("открытие канала: {e}"))?;
    channel
        .request_subsystem(true, "sftp")
        .await
        .map_err(|e| format!("запуск sftp-подсистемы: {e}"))?;
    let sftp = russh_sftp::client::SftpSession::new(channel.into_stream())
        .await
        .map_err(|e| format!("инициализация SFTP: {e}"))?;

    let entries = sftp
        .read_dir(&stats_path)
        .await
        .map_err(|e| format!("чтение папки {stats_path}: {e}"))?;

    let mut updated = 0usize;
    for entry in entries {
        let name = entry.file_name();
        let Some(uuid) = name.strip_suffix(".json") else {
            continue;
        };
        let path = format!("{}/{}", stats_path.trim_end_matches('/'), name);
        let bytes = match sftp.read(&path).await {
            Ok(b) => b,
            Err(_) => continue,
        };
        let Ok(json) = serde_json::from_slice::<serde_json::Value>(&bytes) else {
            continue;
        };
        let ticks = json
            .pointer("/stats/minecraft:custom/minecraft:play_time")
            .or_else(|| json.pointer("/stats/minecraft:custom/minecraft:play_one_minute"))
            .and_then(|v| v.as_i64())
            .unwrap_or(0);
        let seconds = ticks / 20;
        if state
            .store
            .set_playtime_absolute(uuid, seconds)
            .await
            .is_ok()
        {
            updated += 1;
        }
    }

    let _ = session
        .disconnect(russh::Disconnect::ByApplication, "", "en")
        .await;

    Ok(updated)
}

/// `POST /api/settings/sync-stats` — ручной запуск синхронизации статистики.
async fn sync_stats(
    State(state): State<Shared>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, ApiError> {
    require_admin(&state, &headers).await?;
    let updated = do_sync_stats(&state)
        .await
        .map_err(|e| ApiError::new(StatusCode::BAD_REQUEST, e))?;
    Ok(Json(serde_json::json!({ "updated": updated })))
}

/// `GET /api/accounts/:uuid/stats` — время игры и дата последнего запуска.
async fn account_stats(
    State(state): State<Shared>,
    headers: HeaderMap,
    Path(uuid): Path<String>,
) -> Result<Json<protocol::PlayerStats>, ApiError> {
    require_admin(&state, &headers).await?;
    let (playtime_seconds, last_launched_at) =
        state.store.get_playtime(&uuid).await.map_err(map_store)?;
    Ok(Json(protocol::PlayerStats {
        playtime_seconds,
        last_launched_at: last_launched_at
            .map(|t| t.format(&Rfc3339).unwrap_or_default()),
    }))
}

// ─────────────────── Бейджи и градиенты (CRUD) ───────────────────

#[derive(Deserialize)]
struct BadgeInput {
    emoji: String,
    label: String,
    color: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GradientInput {
    label: String,
    color_start: String,
    color_end: String,
}

#[derive(Deserialize)]
struct IdList {
    ids: Vec<i32>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ActiveInput {
    badge_id: Option<i32>,
    gradient_id: Option<i32>,
}

async fn list_badges(
    State(state): State<Shared>,
    headers: HeaderMap,
) -> Result<Json<Vec<protocol::Badge>>, ApiError> {
    require_admin(&state, &headers).await?;
    let badges = state.store.list_badges().await.map_err(map_store)?;
    Ok(Json(badges))
}

async fn create_badge(
    State(state): State<Shared>,
    headers: HeaderMap,
    Json(input): Json<BadgeInput>,
) -> Result<Json<protocol::Badge>, ApiError> {
    require_admin(&state, &headers).await?;
    let badge = state.store.create_badge(&input.emoji, &input.label, &input.color)
        .await.map_err(map_store)?;
    Ok(Json(badge))
}

async fn update_badge(
    State(state): State<Shared>,
    headers: HeaderMap,
    Path(id): Path<i32>,
    Json(input): Json<BadgeInput>,
) -> Result<(), ApiError> {
    require_admin(&state, &headers).await?;
    state.store.update_badge(id, &input.emoji, &input.label, &input.color)
        .await.map_err(map_store)?;
    Ok(())
}

async fn delete_badge(
    State(state): State<Shared>,
    headers: HeaderMap,
    Path(id): Path<i32>,
) -> Result<(), ApiError> {
    require_admin(&state, &headers).await?;
    state.store.delete_badge(id).await.map_err(map_store)?;
    Ok(())
}

async fn list_gradients(
    State(state): State<Shared>,
    headers: HeaderMap,
) -> Result<Json<Vec<protocol::Gradient>>, ApiError> {
    require_admin(&state, &headers).await?;
    let gradients = state.store.list_gradients().await.map_err(map_store)?;
    Ok(Json(gradients))
}

async fn create_gradient(
    State(state): State<Shared>,
    headers: HeaderMap,
    Json(input): Json<GradientInput>,
) -> Result<Json<protocol::Gradient>, ApiError> {
    require_admin(&state, &headers).await?;
    let gradient = state.store.create_gradient(&input.label, &input.color_start, &input.color_end)
        .await.map_err(map_store)?;
    Ok(Json(gradient))
}

async fn update_gradient(
    State(state): State<Shared>,
    headers: HeaderMap,
    Path(id): Path<i32>,
    Json(input): Json<GradientInput>,
) -> Result<(), ApiError> {
    require_admin(&state, &headers).await?;
    state.store.update_gradient(id, &input.label, &input.color_start, &input.color_end)
        .await.map_err(map_store)?;
    Ok(())
}

async fn delete_gradient(
    State(state): State<Shared>,
    headers: HeaderMap,
    Path(id): Path<i32>,
) -> Result<(), ApiError> {
    require_admin(&state, &headers).await?;
    state.store.delete_gradient(id).await.map_err(map_store)?;
    Ok(())
}

async fn get_account_customization(
    State(state): State<Shared>,
    headers: HeaderMap,
    Path(uuid): Path<String>,
) -> Result<Json<protocol::PlayerCustomization>, ApiError> {
    require_admin(&state, &headers).await?;
    let account = state.store.find_by_uuid(&uuid).await
        .ok_or_else(|| ApiError::new(StatusCode::NOT_FOUND, "Аккаунт не найден"))?;
    let owned_badges = state.store.player_available_badges(&uuid).await.map_err(map_store)?;
    let owned_gradients = state.store.player_available_gradients(&uuid).await.map_err(map_store)?;
    let owned_badge_ids = owned_badges.iter().map(|b| b.id).collect();
    let owned_gradient_ids = owned_gradients.iter().map(|g| g.id).collect();
    let available_badges = state.store.list_badges().await.map_err(map_store)?;
    let available_gradients = state.store.list_gradients().await.map_err(map_store)?;
    Ok(Json(protocol::PlayerCustomization {
        available_badges,
        available_gradients,
        active_badge_id: account.active_badge_id,
        active_gradient_id: account.active_gradient_id,
        owned_badge_ids: Some(owned_badge_ids),
        owned_gradient_ids: Some(owned_gradient_ids),
    }))
}

async fn set_account_badges(
    State(state): State<Shared>,
    headers: HeaderMap,
    Path(uuid): Path<String>,
    Json(input): Json<IdList>,
) -> Result<(), ApiError> {
    require_admin(&state, &headers).await?;
    state.store.set_player_badges(&uuid, &input.ids).await.map_err(map_store)?;
    Ok(())
}

async fn set_account_gradients(
    State(state): State<Shared>,
    headers: HeaderMap,
    Path(uuid): Path<String>,
    Json(input): Json<IdList>,
) -> Result<(), ApiError> {
    require_admin(&state, &headers).await?;
    state.store.set_player_gradients(&uuid, &input.ids).await.map_err(map_store)?;
    Ok(())
}

async fn set_account_active(
    State(state): State<Shared>,
    headers: HeaderMap,
    Path(uuid): Path<String>,
    Json(input): Json<ActiveInput>,
) -> Result<(), ApiError> {
    require_admin(&state, &headers).await?;
    state.store.set_active_customization(&uuid, input.badge_id, input.gradient_id)
        .await.map_err(map_store)?;
    Ok(())
}

/// Нормализует UUID для сравнения (убирает дефисы, нижний регистр).
fn normalize_for_compare(uuid: &str) -> String {
    uuid.chars()
        .filter(|c| *c != '-')
        .flat_map(char::to_lowercase)
        .collect()
}

// ───────────────────────── Манифест (для лаунчера) ─────────────────────────

/// Клиентский манифест активной сборки. Публичный (без авторизации).
async fn manifest(State(state): State<Shared>) -> Result<Json<protocol::Manifest>, ApiError> {
    let record = state
        .store
        .active_build()
        .await
        .map_err(internal)?
        .ok_or_else(|| ApiError::new(StatusCode::NOT_FOUND, "Нет активной сборки"))?;
    Ok(Json(record.client_manifest(&state.files_base_url)))
}

// ───────────────────── проверка сборки ─────────────────────

/// `GET /api/build-check` — проверяет что все файлы активной сборки лежат на диске.
///
/// Для каждого файла сборки проверяет наличие `<modpack_dir>/<sha1>` и размер.
/// Возвращает список проблем (если есть) или пустой массив.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct BuildCheckResult {
    build_id: i64,
    build_name: String,
    total_files: usize,
    problems: Vec<BuildCheckProblem>,
}

#[derive(Serialize)]
struct BuildCheckProblem {
    path: String,
    sha1: String,
    kind: String, // "missing" | "size_mismatch"
    detail: String,
}

/// Опциональный `build_id` для проверки конкретной сборки (не обязательно активной).
#[derive(Deserialize)]
struct BuildCheckQuery {
    build_id: Option<i64>,
}

async fn build_check(
    State(state): State<Shared>,
    Query(q): Query<BuildCheckQuery>,
) -> Result<Json<BuildCheckResult>, ApiError> {
    let record = if let Some(id) = q.build_id {
        state
            .store
            .get_build(id)
            .await
            .map_err(internal)?
            .ok_or_else(|| ApiError::new(StatusCode::NOT_FOUND, "Сборка не найдена"))?
    } else {
        state
            .store
            .active_build()
            .await
            .map_err(internal)?
            .ok_or_else(|| ApiError::new(StatusCode::NOT_FOUND, "Нет активной сборки"))?
    };

    let files = state
        .store
        .build_files(record.header.id)
        .await
        .map_err(internal)?;

    let mut problems = Vec::new();

    for f in &files {
        let path = state.modpack_dir.join(&f.sha1);
        match std::fs::metadata(&path) {
            Ok(meta) => {
                let disk_size = meta.len() as i64;
                if disk_size != f.size_bytes {
                    problems.push(BuildCheckProblem {
                        path: f.path.clone(),
                        sha1: f.sha1.clone(),
                        kind: "size_mismatch".into(),
                        detail: format!(
                            "ожидается {} байт, на диске {}",
                            f.size_bytes, disk_size
                        ),
                    });
                }
            }
            Err(_) => {
                problems.push(BuildCheckProblem {
                    path: f.path.clone(),
                    sha1: f.sha1.clone(),
                    kind: "missing".into(),
                    detail: format!("файл не найден: {}", path.display()),
                });
            }
        }
    }

    Ok(Json(BuildCheckResult {
        build_id: record.header.id,
        build_name: record.header.name.clone(),
        total_files: files.len(),
        problems,
    }))
}

// ───────────────────── проверка зависимостей модов ─────────────────────

/// Встроенные modId, которые не являются модами и не проверяются.
const BUILTIN_MOD_IDS: &[&str] = &[
    "neoforge",
    "minecraft",
    "java",
    "forge",
    "fabricloader",
    "fabric-api",
    "rift",
    "quilt_loader",
];

/// `GET /api/deps-check` — проверяет зависимости модов в активной сборке.
///
/// Читает `META-INF/neoforge.mods.toml` из каждого мод-JAR, парсит
/// `[[dependencies]]` и проверяет что все `type = "required"` зависимости
/// выполнены (есть другой мод с таким `modId` в сборке).
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DepsCheckResult {
    build_id: i64,
    build_name: String,
    total_mods: usize,
    problems: Vec<DepsCheckProblem>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DepsCheckProblem {
    /// Мод, у которого не выполнена зависимость.
    from_mod: String,
    /// Какой modId требуется.
    required_mod: String,
    /// Версионный диапазон из TOML.
    version_range: String,
    /// Тип зависимости (optional, incompatible, etc.).
    dep_type: String,
}

/// Извлекает modId из `[[mods]]` секции `neoforge.mods.toml`.
fn extract_mod_ids(toml_text: &str) -> Vec<String> {
    let Ok(val) = toml::Value::from_str(toml_text) else {
        return Vec::new();
    };
    let Some(mods) = val.get("mods").and_then(|v| v.as_array()) else {
        return Vec::new();
    };
    mods.iter()
        .filter_map(|m| m.get("modId")?.as_str().map(|s| s.to_string()))
        .collect()
}

/// Извлекает зависимости из `[[dependencies.<modId>]]` секций.
/// Возвращает vec![(declaring_mod, required_mod, version_range, dep_type)].
fn extract_dependencies(toml_text: &str) -> Vec<(String, String, String, String)> {
    let Ok(val) = toml::Value::from_str(toml_text) else {
        return Vec::new();
    };
    let Some(deps_table) = val.get("dependencies").and_then(|v| v.as_table()) else {
        return Vec::new();
    };

    let mut result = Vec::new();
    for (declaring_mod, entries) in deps_table {
        let Some(arr) = entries.as_array() else {
            continue;
        };
        for entry in arr {
            let req_mod = match entry.get("modId").and_then(|v| v.as_str()) {
                Some(s) => s.to_string(),
                None => continue,
            };
            let version_range = entry
                .get("versionRange")
                .and_then(|v| v.as_str())
                .unwrap_or("*")
                .to_string();
            let dep_type = entry
                .get("type")
                .and_then(|v| v.as_str())
                .unwrap_or("required")
                .to_string();
            result.push((declaring_mod.clone(), req_mod, version_range, dep_type));
        }
    }
    result
}

/// Читает `neoforge.mods.toml` из JAR-файла по пути на диске.
fn read_neoforge_toml(jar_path: &std::path::Path) -> Option<String> {
    let file = std::fs::File::open(jar_path).ok()?;
    let mut zip = zip::ZipArchive::new(file).ok()?;

    for name in &["META-INF/neoforge.mods.toml", "META-INF/mods.toml"] {
        if let Ok(mut entry) = zip.by_name(name) {
            let mut buf = String::new();
            use std::io::Read;
            if entry.read_to_string(&mut buf).is_ok() {
                return Some(buf);
            }
        }
    }
    None
}

async fn deps_check(
    State(state): State<Shared>,
    Query(q): Query<BuildCheckQuery>,
) -> Result<Json<DepsCheckResult>, ApiError> {
    let record = if let Some(id) = q.build_id {
        state
            .store
            .get_build(id)
            .await
            .map_err(internal)?
            .ok_or_else(|| ApiError::new(StatusCode::NOT_FOUND, "Сборка не найдена"))?
    } else {
        state
            .store
            .active_build()
            .await
            .map_err(internal)?
            .ok_or_else(|| ApiError::new(StatusCode::NOT_FOUND, "Нет активной сборки"))?
    };

    let files = state
        .store
        .build_files(record.header.id)
        .await
        .map_err(internal)?;

    // Собираем modId → путь для каждого мода в сборке.
    let mod_jars: Vec<(String, std::path::PathBuf)> = files
        .iter()
        .filter(|f| f.path.ends_with(".jar") && (f.side == "client" || f.side == "both"))
        .map(|f| (f.path.clone(), state.modpack_dir.join(&f.sha1)))
        .collect();

    // Читаем metadatas: modId → (jar_path, provided_mod_ids, raw_toml).
    let mut all_provided: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut mod_entries: Vec<(String, std::path::PathBuf, Vec<String>, String)> = Vec::new();

    for (path, jar_path) in &mod_jars {
        let Some(toml_text) = read_neoforge_toml(jar_path) else {
            continue;
        };
        let mod_ids = extract_mod_ids(&toml_text);
        for id in &mod_ids {
            all_provided.insert(id.clone());
        }
        mod_entries.push((path.clone(), jar_path.clone(), mod_ids, toml_text));
    }

    let mut problems = Vec::new();

    for (path, _jar_path, mod_ids, toml_text) in &mod_entries {
        let deps = extract_dependencies(toml_text);
        for (_declaring, req_mod, version_range, dep_type) in deps {
            // Проверяем только required зависимости.
            if dep_type != "required" {
                continue;
            }
            // Пропускаем встроенные.
            if BUILTIN_MOD_IDS.contains(&req_mod.as_str()) {
                continue;
            }
            // Пропускаем зависимости на самого себя.
            if mod_ids.contains(&req_mod) {
                continue;
            }
            // Проверяем наличие в сборке.
            if !all_provided.contains(&req_mod) {
                problems.push(DepsCheckProblem {
                    from_mod: path.clone(),
                    required_mod: req_mod,
                    version_range,
                    dep_type,
                });
            }
        }
    }

    Ok(Json(DepsCheckResult {
        build_id: record.header.id,
        build_name: record.header.name.clone(),
        total_mods: mod_jars.len(),
        problems,
    }))
}

// ───────────────────── authlib-injector ─────────────────────

/// `GET /authlib-injector.jar` — отдаёт актуальный authlib-injector.jar.
///
/// Публичный (без авторизации): лаунчер тянет инжектор отсюда, чтобы не
/// зависеть от доступности апстрима у каждого клиента. Сервер кэширует
/// jar в памяти (см. `INJECTOR_TTL`) и проверяет sha256 из `latest.json`.
async fn authlib_injector(State(state): State<Shared>) -> Result<Response, ApiError> {
    let mut guard = state.injector.lock().await;

    let fresh = guard
        .as_ref()
        .map(|c| c.fetched.elapsed() < INJECTOR_TTL)
        .unwrap_or(false);

    if !fresh {
        match fetch_injector(&state.http).await {
            Ok(bytes) => {
                *guard = Some(InjectorCache {
                    bytes,
                    fetched: Instant::now(),
                });
            }
            Err(e) => {
                // Апстрим недоступен — отдаём устаревший кэш, если он есть.
                if guard.is_none() {
                    return Err(ApiError::new(
                        StatusCode::BAD_GATEWAY,
                        format!("Не удалось получить authlib-injector: {e}"),
                    ));
                }
                tracing::warn!("обновление authlib-injector не удалось, отдаю кэш: {e}");
            }
        }
    }

    let bytes = guard
        .as_ref()
        .expect("кэш инжектора должен быть заполнен")
        .bytes
        .clone();

    Ok((
        StatusCode::OK,
        [
            (header::CONTENT_TYPE, "application/java-archive"),
            (header::CACHE_CONTROL, "public, max-age=3600"),
            (
                header::CONTENT_DISPOSITION,
                "attachment; filename=\"authlib-injector.jar\"",
            ),
        ],
        bytes,
    )
        .into_response())
}

/// Метаданные `latest.json` authlib-injector (нужны URL и sha256).
#[derive(Deserialize)]
struct InjectorMeta {
    download_url: String,
    checksums: Option<InjectorChecksums>,
}

#[derive(Deserialize)]
struct InjectorChecksums {
    sha256: Option<String>,
}

/// Скачивает актуальный authlib-injector.jar с апстрима и сверяет sha256.
async fn fetch_injector(http: &reqwest::Client) -> Result<Vec<u8>, String> {
    let meta: InjectorMeta = http
        .get(AUTHLIB_INJECTOR_LATEST)
        .send()
        .await
        .map_err(|e| format!("запрос latest.json: {e}"))?
        .error_for_status()
        .map_err(|e| format!("latest.json: {e}"))?
        .json()
        .await
        .map_err(|e| format!("разбор latest.json: {e}"))?;

    let bytes = http
        .get(&meta.download_url)
        .send()
        .await
        .map_err(|e| format!("загрузка jar: {e}"))?
        .error_for_status()
        .map_err(|e| format!("загрузка jar: {e}"))?
        .bytes()
        .await
        .map_err(|e| format!("чтение jar: {e}"))?
        .to_vec();

    if let Some(expected) = meta.checksums.and_then(|c| c.sha256) {
        let actual = sha256_hex(&bytes);
        if !actual.eq_ignore_ascii_case(expected.trim()) {
            return Err(format!(
                "sha256 не совпадает (ожидали {expected}, получили {actual})"
            ));
        }
    }
    Ok(bytes)
}

// ───────────────────────── Хелперы ─────────────────────────

/// Проверяет bearer-токен и роль `admin`.
async fn require_admin(state: &Shared, headers: &HeaderMap) -> Result<store::Account, ApiError> {
    let token = bearer_token(headers)?;
    let uuid = state
        .store
        .validate_session(&token)
        .await
        .ok_or_else(|| ApiError::new(StatusCode::UNAUTHORIZED, "Сессия недействительна"))?;
    let account = state
        .store
        .find_by_uuid(&uuid)
        .await
        .ok_or_else(|| ApiError::new(StatusCode::UNAUTHORIZED, "Аккаунт не найден"))?;
    if !account.is_admin() {
        return Err(ApiError::new(StatusCode::FORBIDDEN, "Недостаточно прав"));
    }
    Ok(account)
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

fn sha1_hex(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut hasher = Sha1::new();
    hasher.update(bytes);
    let digest = hasher.finalize();
    let mut out = String::with_capacity(40);
    for &b in &digest {
        out.push(HEX[(b >> 4) as usize] as char);
        out.push(HEX[(b & 0x0f) as usize] as char);
    }
    out
}

fn sha256_hex(bytes: &[u8]) -> String {
    use sha2::{Digest as _, Sha256};
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    let digest = hasher.finalize();
    let mut out = String::with_capacity(64);
    for &b in &digest {
        out.push(HEX[(b >> 4) as usize] as char);
        out.push(HEX[(b & 0x0f) as usize] as char);
    }
    out
}

fn internal(e: impl std::fmt::Display) -> ApiError {
    ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, e.to_string())
}

fn map_store(e: store::StoreError) -> ApiError {
    match e {
        store::StoreError::NotFound => ApiError::new(StatusCode::NOT_FOUND, "Не найдено"),
        other => ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, other.to_string()),
    }
}
