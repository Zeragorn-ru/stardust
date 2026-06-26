// HTTP-клиент к auth-серверу.
//
// Базовый URL берётся из переменной окружения `LAUNCHER_AUTH_URL`
// (напр. `http://127.0.0.1:8080`). Если она не задана — используется
// локальный сервер по умолчанию, удобно для разработки.

use base64::Engine;
use protocol::{
    AccountInfo, AuthResponse, ChangePasswordRequest, ChangeUsernameRequest, Credentials,
    PlayerProfile, SessionResponse, SkinImportRequest, SkinUploadRequest,
};
use serde::Deserialize;

/// URL auth-сервера по умолчанию (продакшен). Для локальной разработки
/// перекрывается переменной окружения `LAUNCHER_AUTH_URL`.
const DEFAULT_AUTH_URL: &str = "https://auth.zeragorn.xyz";

/// URL admin-сервиса (раздаёт манифест активной сборки и файлы модпака).
/// Перекрывается переменной окружения `LAUNCHER_ADMIN_URL`.
const DEFAULT_ADMIN_URL: &str = "https://admin.zeragorn.xyz";

/// Базовый URL auth-сервера без завершающего слэша.
pub fn base_url() -> String {
    std::env::var("LAUNCHER_AUTH_URL")
        .ok()
        .map(|s| s.trim().trim_end_matches('/').to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| DEFAULT_AUTH_URL.to_string())
}

/// Базовый URL admin-сервиса без завершающего слэша.
pub fn admin_base_url() -> String {
    std::env::var("LAUNCHER_ADMIN_URL")
        .ok()
        .map(|s| s.trim().trim_end_matches('/').to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| DEFAULT_ADMIN_URL.to_string())
}

/// GET `/manifest`. Манифест активной сборки.
///
/// `Ok(None)` — активной сборки нет (404): это не ошибка, лаунчер просто
/// запускает игру без модпака. `Err` — реальная сетевая/серверная проблема.
pub async fn fetch_manifest(
    client: &reqwest::Client,
) -> Result<Option<protocol::Manifest>, String> {
    let resp = client
        .get(format!("{}/manifest", admin_base_url()))
        .send()
        .await
        .map_err(network_error)?;

    if resp.status() == reqwest::StatusCode::NOT_FOUND {
        return Ok(None);
    }
    if !resp.status().is_success() {
        return Err(format!(
            "Ошибка сервера сборок ({})",
            resp.status().as_u16()
        ));
    }
    resp.json::<protocol::Manifest>()
        .await
        .map(Some)
        .map_err(|e| format!("Некорректный манифест сборки: {e}"))
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

/// POST `/api/login`.
pub async fn login(
    client: &reqwest::Client,
    username: &str,
    password: &str,
) -> Result<AuthResponse, String> {
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
    parse_auth(resp).await
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
