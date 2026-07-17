// HTTP-клиент к auth-серверу.
//
// Базовый URL берётся из переменной окружения `LAUNCHER_AUTH_URL`
// (напр. `http://127.0.0.1:8080`). Если она не задана — используется
// локальный сервер по умолчанию, удобно для разработки.

use base64::Engine;
use protocol::{
    AccountInfo, AuthResponse, ChallengeStatus, ChallengeStatusRequest, ChangePasswordRequest,
    ChangeUsernameRequest, Credentials, DeleteAccountRequest, LoginResult, PasswordResetConfirm,
    PasswordResetRequest, PasswordlessLoginRequest, PlayerProfile, PlayerStats,
    RecordSessionRequest, SessionResponse, SkinImportRequest, SkinUploadRequest,
    TelegramLinkResponse, TwoFactorRequest,
};
use serde::Deserialize;
use std::sync::OnceLock;

/// URL auth-сервера по умолчанию (продакшен). Для локальной разработки
/// перекрывается переменной окружения `LAUNCHER_AUTH_URL`.
const DEFAULT_AUTH_URL: &str = "https://auth.zeragorn.xyz";

/// URL admin-сервиса (раздаёт манифест активной сборки и файлы модпака).
/// Перекрывается переменной окружения `LAUNCHER_ADMIN_URL`.
const DEFAULT_ADMIN_URL: &str = "https://admin.zeragorn.xyz";

/// Базовый URL auth-сервера без завершающего слэша.
pub fn base_url() -> &'static str {
    static URL: OnceLock<String> = OnceLock::new();
    URL.get_or_init(|| {
        std::env::var("LAUNCHER_AUTH_URL")
            .ok()
            .map(|s| s.trim().trim_end_matches('/').to_string())
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| DEFAULT_AUTH_URL.to_string())
    })
}

/// Базовый URL admin-сервиса без завершающего слэша.
pub fn admin_base_url() -> &'static str {
    static URL: OnceLock<String> = OnceLock::new();
    URL.get_or_init(|| {
        std::env::var("LAUNCHER_ADMIN_URL")
            .ok()
            .map(|s| s.trim().trim_end_matches('/').to_string())
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| DEFAULT_ADMIN_URL.to_string())
    })
}

/// GET `/manifest`. Манифест активной сборки.
///
/// `Ok(None)` — активной сборки нет (404): это не ошибка, лаунчер просто
/// запускает игру без модпака. `Err` — реальная сетевая/серверная проблема.
///
/// При успешном скачивании манифест кешируется на диск (`cached-manifest.json`).
/// При сетевой ошибке отдаёт последнюю известную версию из кеша.
pub async fn fetch_manifest(
    client: &reqwest::Client,
    data_dir: &std::path::Path,
) -> Result<Option<protocol::Manifest>, String> {
    let cache_path = data_dir.join("cached-manifest.json");

    match client
        .get(format!("{}/manifest", admin_base_url()))
        .send()
        .await
    {
        Ok(resp) if resp.status() == reqwest::StatusCode::NOT_FOUND => {
            // Активной сборки нет — удаляем кеш.
            let _ = std::fs::remove_file(&cache_path);
            Ok(None)
        }
        Ok(resp) if resp.status().is_success() => {
            match resp.json::<protocol::Manifest>().await {
                Ok(manifest) => {
                    // Сохраняем в кеш (best-effort).
                    let _ = std::fs::write(
                        &cache_path,
                        serde_json::to_vec(&manifest).unwrap_or_default(),
                    );
                    tracing::debug!("[manifest] скачан и закеширован");
                    Ok(Some(manifest))
                }
                Err(e) => Err(format!("Некорректный манифест сборки: {e}")),
            }
        }
        Ok(resp) => Err(format!(
            "Ошибка сервера сборок ({})",
            resp.status().as_u16()
        )),
        Err(e) => {
            // Сетевая ошибка — пробуем кеш.
            tracing::warn!("[manifest] сетевая ошибка ({e}), пробуем кеш");
            if let Ok(bytes) = std::fs::read(&cache_path) {
                if let Ok(manifest) = serde_json::from_slice(&bytes) {
                    tracing::info!("[manifest] использован кешированный манифест");
                    return Ok(Some(manifest));
                }
            }
            Err(network_error(e))
        }
    }
}

/// Тело ошибки, которое отдаёт auth-сервер: `{ "error": "..." }`.
#[derive(Deserialize)]
struct ErrorBody {
    error: String,
}

/// Общая обработка ответа: 2xx → профиль+токен, иначе — текст ошибки сервера.
async fn parse_auth(resp: reqwest::Response) -> Result<AuthResponse, String> {
    let status = resp.status();
    if status.is_success() {
        return resp
            .json::<AuthResponse>()
            .await
            .map_err(|e| format!("Некорректный ответ сервера: {e}"));
    }

    // Пытаемся достать осмысленное сообщение из тела `{error}`.
    match resp.json::<ErrorBody>().await {
        Ok(body) => Err(body.error),
        Err(_) => Err(format!("Ошибка сервера ({})", status.as_u16())),
    }
}

/// Общая обработка ответа на опрос статуса challenge: 2xx → `ChallengeStatus`,
/// иначе — текст ошибки сервера.
async fn parse_challenge_status(resp: reqwest::Response) -> Result<ChallengeStatus, String> {
    let status = resp.status();
    if status.is_success() {
        return resp
            .json::<ChallengeStatus>()
            .await
            .map_err(|e| format!("Некорректный ответ сервера: {e}"));
    }

    match resp.json::<ErrorBody>().await {
        Ok(body) => Err(body.error),
        Err(_) => Err(format!("Ошибка сервера ({})", status.as_u16())),
    }
}

/// Общая обработка ответа, возвращающего `LoginResult` (вход / passwordless /
/// старт сброса пароля).
async fn parse_login_result(resp: reqwest::Response) -> Result<LoginResult, String> {
    let status = resp.status();
    if status.is_success() {
        return resp
            .json::<LoginResult>()
            .await
            .map_err(|e| format!("Некорректный ответ сервера: {e}"));
    }
    match resp.json::<ErrorBody>().await {
        Ok(body) => Err(body.error),
        Err(_) => Err(format!("Ошибка сервера ({})", status.as_u16())),
    }
}

/// Превращает сетевую ошибку reqwest в понятное пользователю сообщение.
fn network_error(e: reqwest::Error) -> String {
    if e.is_connect() {
        "Не удалось подключиться к серверу авторизации".to_string()
    } else if e.is_timeout() {
        "Сервер авторизации не отвечает".to_string()
    } else {
        format!("Сетевая ошибка: {e}")
    }
}

async fn parse_profile(resp: reqwest::Response) -> Result<PlayerProfile, String> {
    let status = resp.status();
    if status.is_success() {
        return resp
            .json::<SessionResponse>()
            .await
            .map(|s| s.profile)
            .map_err(|e| format!("Некорректный ответ сервера: {e}"));
    }

    match resp.json::<ErrorBody>().await {
        Ok(body) => Err(body.error),
        Err(_) => Err(format!("Ошибка сервера ({})", status.as_u16())),
    }
}

/// POST `/api/login`. Возвращает либо сессию, либо требование 2FA.
pub async fn login(
    client: &reqwest::Client,
    username: &str,
    password: &str,
) -> Result<LoginResult, String> {
    let creds = Credentials {
        username: username.to_string(),
        password: password.to_string(),
    };
    let resp = client
        .post(format!("{}/api/login", base_url()))
        .json(&creds)
        .send()
        .await
        .map_err(network_error)?;
    parse_login_result(resp).await
}

/// POST `/api/login/2fa`. Подтверждение кода из Telegram, выдаёт сессию.
pub async fn login_2fa(
    client: &reqwest::Client,
    challenge: &str,
    code: &str,
) -> Result<AuthResponse, String> {
    let req = TwoFactorRequest {
        challenge: challenge.to_string(),
        code: code.to_string(),
    };
    let resp = client
        .post(format!("{}/api/login/2fa", base_url()))
        .json(&req)
        .send()
        .await
        .map_err(network_error)?;
    parse_auth(resp).await
}

/// POST `/api/login/2fa/status`. Опрос подтверждения входа кнопкой в Telegram.
pub async fn login_2fa_status(
    client: &reqwest::Client,
    challenge: &str,
) -> Result<ChallengeStatus, String> {
    let req = ChallengeStatusRequest {
        challenge: challenge.to_string(),
    };
    let resp = client
        .post(format!("{}/api/login/2fa/status", base_url()))
        .json(&req)
        .send()
        .await
        .map_err(network_error)?;
    parse_challenge_status(resp).await
}

/// POST `/api/login/passwordless`. Вход без пароля: по нику. Возвращает
/// требование подтверждения кнопкой в Telegram.
pub async fn passwordless_login(
    client: &reqwest::Client,
    username: &str,
) -> Result<LoginResult, String> {
    let req = PasswordlessLoginRequest {
        username: username.to_string(),
    };
    let resp = client
        .post(format!("{}/api/login/passwordless", base_url()))
        .json(&req)
        .send()
        .await
        .map_err(network_error)?;
    parse_login_result(resp).await
}

/// POST `/api/login/passwordless/status`. Опрос подтверждения входа без пароля.
pub async fn passwordless_status(
    client: &reqwest::Client,
    challenge: &str,
) -> Result<ChallengeStatus, String> {
    let req = ChallengeStatusRequest {
        challenge: challenge.to_string(),
    };
    let resp = client
        .post(format!("{}/api/login/passwordless/status", base_url()))
        .json(&req)
        .send()
        .await
        .map_err(network_error)?;
    parse_challenge_status(resp).await
}

/// POST `/api/password/reset`. Запуск сброса пароля: по нику. Возвращает
/// challenge для подтверждения кнопкой в Telegram.
pub async fn password_reset_start(
    client: &reqwest::Client,
    username: &str,
) -> Result<LoginResult, String> {
    let req = PasswordResetRequest {
        username: username.to_string(),
    };
    let resp = client
        .post(format!("{}/api/password/reset", base_url()))
        .json(&req)
        .send()
        .await
        .map_err(network_error)?;
    parse_login_result(resp).await
}

/// POST `/api/password/reset/status`. Опрос подтверждения сброса пароля. При
/// подтверждении возвращает `Approved` без сессии — нужно вызвать `confirm`.
pub async fn password_reset_status(
    client: &reqwest::Client,
    challenge: &str,
) -> Result<ChallengeStatus, String> {
    let req = ChallengeStatusRequest {
        challenge: challenge.to_string(),
    };
    let resp = client
        .post(format!("{}/api/password/reset/status", base_url()))
        .json(&req)
        .send()
        .await
        .map_err(network_error)?;
    parse_challenge_status(resp).await
}

/// POST `/api/password/reset/confirm`. Установка нового пароля после
/// подтверждения сброса кнопкой в Telegram.
pub async fn password_reset_confirm(
    client: &reqwest::Client,
    challenge: &str,
    code: &str,
    new_password: &str,
) -> Result<(), String> {
    let req = PasswordResetConfirm {
        challenge: challenge.to_string(),
        code: code.to_string(),
        new_password: new_password.to_string(),
    };
    let resp = client
        .post(format!("{}/api/password/reset/confirm", base_url()))
        .json(&req)
        .send()
        .await
        .map_err(network_error)?;
    if resp.status().is_success() {
        return Ok(());
    }
    match resp.json::<ErrorBody>().await {
        Ok(body) => Err(body.error),
        Err(_) => Err("Не удалось установить новый пароль".to_string()),
    }
}

/// POST `/api/register`.
pub async fn register(
    client: &reqwest::Client,
    username: &str,
    password: &str,
) -> Result<AuthResponse, String> {
    let creds = Credentials {
        username: username.to_string(),
        password: password.to_string(),
    };
    let resp = client
        .post(format!("{}/api/register", base_url()))
        .json(&creds)
        .send()
        .await
        .map_err(network_error)?;
    parse_auth(resp).await
}

/// Скин, полученный с сервера: PNG в base64 и модель.
pub struct FetchedSkin {
    pub png_base64: String,
    pub model: String,
    /// UUID лицензии-источника, если скин синхронизируется с Mojang.
    pub source: Option<String>,
}

/// GET `/api/skin/:uuid`. Возвращает `None`, если скин у аккаунта не задан.
pub async fn get_skin(client: &reqwest::Client, uuid: &str) -> Result<Option<FetchedSkin>, String> {
    let resp = client
        .get(format!("{}/api/skin/{uuid}", base_url()))
        .send()
        .await
        .map_err(network_error)?;

    if resp.status() == reqwest::StatusCode::NOT_FOUND {
        return Ok(None);
    }
    if !resp.status().is_success() {
        return Err(format!("Ошибка сервера ({})", resp.status().as_u16()));
    }

    let model = resp
        .headers()
        .get("x-skin-model")
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_string())
        .unwrap_or_else(|| "classic".to_string());

    // UUID лицензии-источника, если скин синхронизируется с Mojang.
    let source = resp
        .headers()
        .get("x-skin-source")
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_string());

    let bytes = resp.bytes().await.map_err(network_error)?;
    let png_base64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
    Ok(Some(FetchedSkin {
        png_base64,
        model,
        source,
    }))
}

/// GET `/api/cape/:uuid`. Возвращает `None`, если плащ у аккаунта не задан.
pub async fn get_cape(client: &reqwest::Client, uuid: &str) -> Result<Option<String>, String> {
    let resp = client
        .get(format!("{}/api/cape/{uuid}", base_url()))
        .send()
        .await
        .map_err(network_error)?;

    if resp.status() == reqwest::StatusCode::NOT_FOUND {
        return Ok(None);
    }
    if !resp.status().is_success() {
        return Err(format!("Ошибка сервера ({})", resp.status().as_u16()));
    }

    let bytes = resp.bytes().await.map_err(network_error)?;
    Ok(Some(
        base64::engine::general_purpose::STANDARD.encode(&bytes),
    ))
}

/// POST `/api/skin/import`. Импорт скина+плаща с лицензионного аккаунта.
///
/// `source` — ник Mojang или UUID. `keep_synced` — периодически обновлять
/// скин по этому источнику (UUID лицензии хранится на сервере).
pub async fn import_skin(
    client: &reqwest::Client,
    token: &str,
    uuid: &str,
    source: &str,
    keep_synced: bool,
) -> Result<(), String> {
    let req = SkinImportRequest {
        uuid: uuid.to_string(),
        source: source.to_string(),
        keep_synced,
    };
    let resp = client
        .post(format!("{}/api/skin/import", base_url()))
        .bearer_auth(token)
        .json(&req)
        .send()
        .await
        .map_err(network_error)?;

    if resp.status().is_success() {
        return Ok(());
    }
    match resp.json::<ErrorBody>().await {
        Ok(body) => Err(body.error),
        Err(_) => Err("Не удалось импортировать скин с лицензии".to_string()),
    }
}

/// GET `/api/session`. Проверяет сохранённый токен и возвращает профиль.
pub async fn session(client: &reqwest::Client, token: &str) -> Result<PlayerProfile, String> {
    let resp = client
        .get(format!("{}/api/session", base_url()))
        .bearer_auth(token)
        .send()
        .await
        .map_err(network_error)?;
    parse_profile(resp).await
}

/// POST `/api/logout`.
pub async fn logout(client: &reqwest::Client, token: &str) -> Result<(), String> {
    let resp = client
        .post(format!("{}/api/logout", base_url()))
        .bearer_auth(token)
        .send()
        .await
        .map_err(network_error)?;

    if resp.status().is_success() {
        Ok(())
    } else {
        Err(format!("Ошибка сервера ({})", resp.status().as_u16()))
    }
}

pub async fn upload_skin(
    client: &reqwest::Client,
    token: &str,
    uuid: &str,
    png_base64: &str,
    model: protocol::SkinModel,
) -> Result<(), String> {
    let req = SkinUploadRequest {
        uuid: uuid.to_string(),
        png_base64: png_base64.to_string(),
        model,
    };
    let resp = client
        .post(format!("{}/api/skin/upload", base_url()))
        .bearer_auth(token)
        .json(&req)
        .send()
        .await
        .map_err(network_error)?;

    if resp.status().is_success() {
        return Ok(());
    }
    match resp.json::<ErrorBody>().await {
        Ok(body) => Err(body.error),
        Err(_) => Err("Не удалось загрузить скин".to_string()),
    }
}

// ---------- Аккаунт ----------

/// GET `/api/account`. Расширенные сведения об аккаунте владельца.
pub async fn account_info(client: &reqwest::Client, token: &str) -> Result<AccountInfo, String> {
    let resp = client
        .get(format!("{}/api/account", base_url()))
        .bearer_auth(token)
        .send()
        .await
        .map_err(network_error)?;
    if resp.status().is_success() {
        return resp
            .json::<AccountInfo>()
            .await
            .map_err(|e| format!("Некорректный ответ сервера: {e}"));
    }
    match resp.json::<ErrorBody>().await {
        Ok(body) => Err(body.error),
        Err(_) => Err("Не удалось получить данные аккаунта".to_string()),
    }
}

/// POST `/api/account/username`. Смена ника, возвращает обновлённый профиль.
pub async fn change_username(
    client: &reqwest::Client,
    token: &str,
    new_username: &str,
) -> Result<PlayerProfile, String> {
    let req = ChangeUsernameRequest {
        new_username: new_username.to_string(),
    };
    let resp = client
        .post(format!("{}/api/account/username", base_url()))
        .bearer_auth(token)
        .json(&req)
        .send()
        .await
        .map_err(network_error)?;
    if resp.status().is_success() {
        return resp
            .json::<PlayerProfile>()
            .await
            .map_err(|e| format!("Некорректный ответ сервера: {e}"));
    }
    match resp.json::<ErrorBody>().await {
        Ok(body) => Err(body.error),
        Err(_) => Err("Не удалось сменить имя".to_string()),
    }
}

/// POST `/api/account/password`. Смена пароля (требует текущий).
pub async fn change_password(
    client: &reqwest::Client,
    token: &str,
    current_password: &str,
    new_password: &str,
) -> Result<(), String> {
    let req = ChangePasswordRequest {
        current_password: current_password.to_string(),
        new_password: new_password.to_string(),
    };
    let resp = client
        .post(format!("{}/api/account/password", base_url()))
        .bearer_auth(token)
        .json(&req)
        .send()
        .await
        .map_err(network_error)?;
    if resp.status().is_success() {
        return Ok(());
    }
    match resp.json::<ErrorBody>().await {
        Ok(body) => Err(body.error),
        Err(_) => Err("Не удалось сменить пароль".to_string()),
    }
}

/// POST `/api/account/delete`. Само-удаление аккаунта (требует пароль).
pub async fn delete_account(
    client: &reqwest::Client,
    token: &str,
    password: &str,
) -> Result<(), String> {
    let req = DeleteAccountRequest {
        password: password.to_string(),
    };
    let resp = client
        .post(format!("{}/api/account/delete", base_url()))
        .bearer_auth(token)
        .json(&req)
        .send()
        .await
        .map_err(network_error)?;
    if resp.status().is_success() {
        return Ok(());
    }
    match resp.json::<ErrorBody>().await {
        Ok(body) => Err(body.error),
        Err(_) => Err("Не удалось удалить аккаунт".to_string()),
    }
}

/// POST `/api/account/telegram/start`. Запрашивает код привязки Telegram.
pub async fn telegram_link_start(
    client: &reqwest::Client,
    token: &str,
) -> Result<TelegramLinkResponse, String> {
    let resp = client
        .post(format!("{}/api/account/telegram/start", base_url()))
        .bearer_auth(token)
        .send()
        .await
        .map_err(network_error)?;
    if resp.status().is_success() {
        return resp
            .json::<TelegramLinkResponse>()
            .await
            .map_err(|e| format!("Некорректный ответ сервера: {e}"));
    }
    match resp.json::<ErrorBody>().await {
        Ok(body) => Err(body.error),
        Err(_) => Err("Не удалось начать привязку Telegram".to_string()),
    }
}

/// POST `/api/account/telegram/unlink`. Отвязывает Telegram (отключает 2FA).
pub async fn telegram_unlink(client: &reqwest::Client, token: &str) -> Result<(), String> {
    let resp = client
        .post(format!("{}/api/account/telegram/unlink", base_url()))
        .bearer_auth(token)
        .send()
        .await
        .map_err(network_error)?;
    if resp.status().is_success() {
        return Ok(());
    }
    match resp.json::<ErrorBody>().await {
        Ok(body) => Err(body.error),
        Err(_) => Err("Не удалось отвязать Telegram".to_string()),
    }
}

/// GET `/api/stats`. Получить статистику игрока (playtime, lastJoinedAt).
pub async fn get_stats(client: &reqwest::Client, token: &str) -> Result<PlayerStats, String> {
    let resp = client
        .get(format!("{}/api/stats", base_url()))
        .bearer_auth(token)
        .send()
        .await
        .map_err(network_error)?;
    if resp.status().is_success() {
        return resp
            .json::<PlayerStats>()
            .await
            .map_err(|e| format!("Некорректный ответ сервера: {e}"));
    }
    match resp.json::<ErrorBody>().await {
        Ok(body) => Err(body.error),
        Err(_) => Err("Не удалось получить статистику".to_string()),
    }
}

/// POST `/api/stats/session`. Записать завершившуюся игровую сессию.
pub async fn record_session(
    client: &reqwest::Client,
    token: &str,
    duration_seconds: i64,
    launched_at: &str,
) -> Result<(), String> {
    let req = RecordSessionRequest {
        duration_seconds,
        launched_at: launched_at.to_string(),
    };
    let resp = client
        .post(format!("{}/api/stats/session", base_url()))
        .bearer_auth(token)
        .json(&req)
        .send()
        .await
        .map_err(network_error)?;
    if resp.status().is_success() {
        return Ok(());
    }
    match resp.json::<ErrorBody>().await {
        Ok(body) => Err(body.error),
        Err(_) => Err("Не удалось записать сессию".to_string()),
    }
}

#[derive(serde::Serialize)]
struct ReportCrashRequest {
    exit_code: Option<i32>,
    log: String,
    crash_report: Option<String>,
}

pub async fn report_crash(
    client: &reqwest::Client,
    token: &str,
    exit_code: Option<i32>,
    log: &str,
    crash_report: Option<&str>,
) -> Result<(), String> {
    let req = ReportCrashRequest {
        exit_code,
        log: log.to_string(),
        crash_report: crash_report.map(|s| s.to_string()),
    };
    let resp = client
        .post(format!("{}/api/report-crash", base_url()))
        .bearer_auth(token)
        .json(&req)
        .send()
        .await
        .map_err(network_error)?;
    if resp.status().is_success() {
        return Ok(());
    }
    match resp.json::<ErrorBody>().await {
        Ok(body) => Err(body.error),
        Err(_) => Err("Не удалось отправить отчет о краше".to_string()),
    }
}
