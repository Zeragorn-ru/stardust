//! HTTP API клиент для взаимодействия с сервером.

use serde::{Deserialize, Serialize};

const DEFAULT_API_BASE: &str = "http://localhost:8080";

/// Профиль игрока.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Profile {
    pub name: String,
    pub uuid: String,
    pub access_token: String,
    pub client_token: String,
}

/// Статистика игрока.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Stats {
    pub playtime_seconds: u64,
    pub last_launched: Option<chrono::DateTime<chrono::Utc>>,
}

/// Статус сервера.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ServerStatus {
    pub online: bool,
    pub players: Option<i32>,
    pub max: Option<i32>,
    pub ping: Option<u32>,
}

/// Настройки лаунчера.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Settings {
    pub memory_mb: u32,
    pub download_concurrency: u32,
    pub animations: bool,
    pub show_3d_model: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            memory_mb: 4096,
            download_concurrency: 6,
            animations: true,
            show_3d_model: true,
        }
    }
}

/// Информация о сборке.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BuildInfo {
    pub name: String,
    pub version: String,
    pub mc_version: String,
    pub loader_kind: String,
    pub loader_version: String,
}

/// Манифест файлов.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Manifest {
    pub name: String,
    pub version: String,
    pub files: Vec<FileEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileEntry {
    pub path: String,
    pub url: String,
    pub sha1: String,
    pub size: u64,
    pub side: String,
    pub kind: String,
    pub overwrite: bool,
    pub optional: bool,
    pub enabled_by_default: bool,
    pub mod_id: Option<String>,
    pub display_name: Option<String>,
    pub description: Option<String>,
}

/// API клиент.
pub struct Client {
    base_url: String,
    http: reqwest::Client,
}

impl Client {
    pub fn new(base_url: Option<String>) -> Self {
        Self {
            base_url: base_url.unwrap_or_else(|| DEFAULT_API_BASE.to_string()),
            http: reqwest::Client::new(),
        }
    }

    /// Вход по логину/паролю.
    pub async fn login(&self, username: &str, password: &str) -> Result<Profile, String> {
        let resp = self.http
            .post(format!("{}/api/auth/login", self.base_url))
            .json(&serde_json::json!({
                "username": username,
                "password": password,
            }))
            .send()
            .await
            .map_err(|e| format!("Ошибка сети: {}", e))?;

        if !resp.status().is_success() {
            let text = resp.text().await.unwrap_or_default();
            return Err(text);
        }

        resp.json::<Profile>().await
            .map_err(|e| format!("Ошибка парсинга: {}", e))
    }

    /// Получить статистику.
    pub async fn get_stats(&self) -> Result<Stats, String> {
        let resp = self.http
            .get(format!("{}/api/stats", self.base_url))
            .send()
            .await
            .map_err(|e| format!("Ошибка сети: {}", e))?;

        resp.json::<Stats>().await
            .map_err(|e| format!("Ошибка парсинга: {}", e))
    }

    /// Пинг сервера.
    pub async fn ping_server(&self) -> Result<ServerStatus, String> {
        let resp = self.http
            .get(format!("{}/api/server/ping", self.base_url))
            .send()
            .await
            .map_err(|e| format!("Ошибка сети: {}", e))?;

        resp.json::<ServerStatus>().await
            .map_err(|e| format!("Ошибка парсинга: {}", e))
    }

    /// Получить настройки.
    pub async fn get_settings(&self) -> Result<Settings, String> {
        let resp = self.http
            .get(format!("{}/api/settings", self.base_url))
            .send()
            .await
            .map_err(|e| format!("Ошибка сети: {}", e))?;

        if !resp.status().is_success() {
            return Ok(Settings::default());
        }

        resp.json::<Settings>().await
            .map_err(|e| format!("Ошибка парсинга: {}", e))
    }

    /// Сохранить настройки.
    pub async fn save_settings(&self, settings: &Settings) -> Result<(), String> {
        self.http
            .put(format!("{}/api/settings", self.base_url))
            .json(settings)
            .send()
            .await
            .map_err(|e| format!("Ошибка сети: {}", e))?;

        Ok(())
    }

    /// Получить манифест сборки.
    pub async fn get_manifest(&self) -> Result<Manifest, String> {
        let resp = self
            .http
            .get(format!("{}/manifest", self.base_url))
            .send()
            .await
            .map_err(|e| format!("Ошибка сети: {}", e))?;

        resp.json::<Manifest>()
            .await
            .map_err(|e| format!("Ошибка парсинга: {}", e))
    }
}

// --- Модульные функции для использования в экранах ---

pub async fn login(username: &str, password: &str) -> Result<Profile, String> {
    Client::new(None).login(username, password).await
}

pub async fn register(username: &str, password: &str) -> Result<Profile, String> {
    let client = Client::new(None);
    let resp = client
        .http
        .post(format!("{}/api/auth/register", client.base_url))
        .json(&serde_json::json!({
            "username": username,
            "password": password,
        }))
        .send()
        .await
        .map_err(|e| format!("Ошибка сети: {}", e))?;

    if !resp.status().is_success() {
        let text = resp.text().await.unwrap_or_default();
        return Err(text);
    }

    resp.json::<Profile>()
        .await
        .map_err(|e| format!("Ошибка парсинга: {}", e))
}

pub async fn get_stats() -> Result<Stats, String> {
    Client::new(None).get_stats().await
}

pub async fn ping_server() -> Result<ServerStatus, String> {
    Client::new(None).ping_server().await
}

pub async fn load_settings() -> Result<Settings, String> {
    Client::new(None).get_settings().await
}

pub async fn save_settings(settings: &Settings) -> Result<(), String> {
    Client::new(None).save_settings(settings).await
}
