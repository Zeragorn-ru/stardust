#![allow(dead_code)]

//! HTTP API клиент — реальные эндпоинты auth.zeragorn.xyz + admin.zeragorn.xyz.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

const AUTH_BASE: &str = "https://auth.zeragorn.xyz";
const ADMIN_BASE: &str = "https://admin.zeragorn.xyz";
const PROXY: &str = "http://assets.zeragorn.xyz:3128";
const VERSION: &str = env!("CARGO_PKG_VERSION");

// ─── Типы ───────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PlayerProfile {
    pub name: String,
    pub uuid: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LoginResult {
    pub profile: PlayerProfile,
    pub access_token: String,
    pub client_token: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionResponse {
    pub profile: PlayerProfile,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SavedSession {
    pub profile: PlayerProfile,
    pub access_token: String,
    pub client_token: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PlayerStats {
    pub playtime_seconds: u64,
    pub last_launched: Option<chrono::DateTime<chrono::Utc>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ServerStatus {
    pub online: bool,
    pub players: Option<i32>,
    pub max: Option<i32>,
    pub ping: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LauncherSettings {
    pub memory_mb: u32,
    pub download_concurrency: u32,
    pub show_3d_model: bool,
}

impl Default for LauncherSettings {
    fn default() -> Self {
        let cpus = std::thread::available_parallelism()
            .map(|n| n.get() as u32)
            .unwrap_or(4)
            .clamp(1, 16);
        Self {
            memory_mb: 4096,
            download_concurrency: cpus,
            show_3d_model: true,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Manifest {
    pub name: String,
    pub version: String,
    #[serde(default)]
    pub loader: LoaderInfo,
    #[serde(default)]
    pub files: Vec<ManifestFile>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LoaderInfo {
    #[serde(default)]
    pub minecraft: String,
    #[serde(default)]
    pub kind: LoaderKind,
    #[serde(default)]
    pub version: String,
}

impl Default for LoaderInfo {
    fn default() -> Self {
        Self {
            minecraft: String::new(),
            kind: LoaderKind::Vanilla,
            version: String::new(),
        }
    }
}


#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum LoaderKind {
    #[default]
    Vanilla,
    Fabric,
    Quilt,
    Forge,
    NeoForge,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ManifestFile {
    pub path: String,
    pub url: String,
    pub sha1: String,
    pub size: u64,
    #[serde(default = "default_side")]
    pub side: String,
    #[serde(default)]
    pub kind: String,
    #[serde(default)]
    pub overwrite: bool,
    #[serde(default)]
    pub optional: bool,
    #[serde(default = "default_true")]
    pub enabled_by_default: bool,
    #[serde(default)]
    pub mod_id: Option<String>,
    #[serde(default)]
    pub display_name: Option<String>,
    #[serde(default)]
    pub description: Option<String>,
}

fn default_side() -> String { "client".to_string() }
fn default_true() -> bool { true }

// ─── HTTP клиент ────────────────────────────────────────────

fn build_client() -> reqwest::Client {
    let mut builder = reqwest::Client::builder()
        .user_agent(format!("stardust-launcher/{VERSION}"))
        .connect_timeout(std::time::Duration::from_secs(5))
        .timeout(std::time::Duration::from_secs(20));

    if let Ok(proxy) = reqwest::Proxy::all(PROXY) {
        builder = builder.proxy(proxy);
    }

    builder.build().unwrap_or_default()
}

// ─── Auth API ───────────────────────────────────────────────

pub async fn login(username: &str, password: &str) -> Result<LoginResult, String> {
    let http = build_client();
    let resp = http
        .post(format!("{AUTH_BASE}/api/login"))
        .json(&serde_json::json!({ "username": username, "password": password }))
        .send()
        .await
        .map_err(|e| format!("Сеть: {e}"))?;

    if !resp.status().is_success() {
        let text = resp.text().await.unwrap_or_default();
        return Err(text);
    }
    resp.json::<LoginResult>().await.map_err(|e| format!("Парсинг: {e}"))
}

pub async fn register(username: &str, password: &str) -> Result<LoginResult, String> {
    let http = build_client();
    let resp = http
        .post(format!("{AUTH_BASE}/api/register"))
        .json(&serde_json::json!({ "username": username, "password": password }))
        .send()
        .await
        .map_err(|e| format!("Сеть: {e}"))?;

    if !resp.status().is_success() {
        let text = resp.text().await.unwrap_or_default();
        return Err(text);
    }
    resp.json::<LoginResult>().await.map_err(|e| format!("Парсинг: {e}"))
}

pub async fn session(token: &str) -> Result<PlayerProfile, String> {
    let http = build_client();
    let resp = http
        .get(format!("{AUTH_BASE}/api/session"))
        .bearer_auth(token)
        .send()
        .await
        .map_err(|e| format!("Сеть: {e}"))?;

    if !resp.status().is_success() {
        return Err(format!("Сессия невалидна (HTTP {})", resp.status()));
    }
    let sr: SessionResponse = resp.json().await.map_err(|e| format!("Парсинг: {e}"))?;
    Ok(sr.profile)
}

pub async fn get_stats(token: &str) -> Result<PlayerStats, String> {
    let http = build_client();
    let resp = http
        .get(format!("{AUTH_BASE}/api/stats"))
        .bearer_auth(token)
        .send()
        .await
        .map_err(|e| format!("Сеть: {e}"))?;

    if !resp.status().is_success() {
        return Err(format!("HTTP {}", resp.status()));
    }
    resp.json::<PlayerStats>().await.map_err(|e| format!("Парсинг: {e}"))
}

pub async fn record_session(token: &str, duration_secs: u64, launched_at: &str) -> Result<(), String> {
    let http = build_client();
    let resp = http
        .post(format!("{AUTH_BASE}/api/stats/session"))
        .bearer_auth(token)
        .json(&serde_json::json!({
            "duration_seconds": duration_secs,
            "launched_at": launched_at,
        }))
        .send()
        .await
        .map_err(|e| format!("Сеть: {e}"))?;

    if !resp.status().is_success() {
        return Err(format!("HTTP {}", resp.status()));
    }
    Ok(())
}

pub async fn get_skin(uuid: &str) -> Result<Vec<u8>, String> {
    let http = build_client();
    let resp = http
        .get(format!("{AUTH_BASE}/api/skin/{uuid}"))
        .send()
        .await
        .map_err(|e| format!("Сеть: {e}"))?;

    if !resp.status().is_success() {
        return Err(format!("HTTP {}", resp.status()));
    }
    resp.bytes().await.map(|b| b.to_vec()).map_err(|e| format!("Чтение: {e}"))
}

// ─── Manifest (Admin) ──────────────────────────────────────

pub async fn fetch_manifest(
    data_dir: &std::path::Path,
) -> Result<Option<Manifest>, String> {
    let http = build_client();
    match http.get(format!("{ADMIN_BASE}/manifest")).send().await {
        Ok(resp) if resp.status().is_success() => {
            let m: Manifest = resp.json().await.map_err(|e| format!("Парсинг: {e}"))?;
            let cache_path = data_dir.join("cached-manifest.json");
            let _ = std::fs::write(&cache_path, serde_json::to_string(&m).unwrap_or_default());
            Ok(Some(m))
        }
        Ok(resp) if resp.status().as_u16() == 404 => {
            let cache_path = data_dir.join("cached-manifest.json");
            let _ = std::fs::remove_file(&cache_path);
            Ok(None)
        }
        Ok(_) | Err(_) => {
            let cache_path = data_dir.join("cached-manifest.json");
            if let Ok(content) = std::fs::read_to_string(&cache_path) {
                if let Ok(m) = serde_json::from_str::<Manifest>(&content) {
                    Ok(Some(m))
                } else {
                    Err("Нет манифеста и нет кеша".to_string())
                }
            } else {
                Err("Нет манифеста и нет кеша".to_string())
            }
        }
    }
}

// ─── Session persistence ───────────────────────────────────

pub fn session_path(data_dir: &Path) -> PathBuf {
    data_dir.join("session.json")
}

pub fn save_session(data_dir: &Path, session: &SavedSession) -> Result<(), String> {
    let json = serde_json::to_string_pretty(session).map_err(|e| format!("Ошибка: {e}"))?;
    std::fs::write(session_path(data_dir), json).map_err(|e| format!("Ошибка записи: {e}"))
}

pub fn load_session(data_dir: &Path) -> Option<SavedSession> {
    let content = std::fs::read_to_string(session_path(data_dir)).ok()?;
    serde_json::from_str(&content).ok()
}

pub fn delete_session(data_dir: &Path) {
    let _ = std::fs::remove_file(session_path(data_dir));
}

// ─── Settings persistence ──────────────────────────────────

pub fn settings_path(data_dir: &Path) -> PathBuf {
    data_dir.join("settings.json")
}

pub fn load_settings(data_dir: &Path) -> LauncherSettings {
    let content = match std::fs::read_to_string(settings_path(data_dir)) {
        Ok(c) => c,
        Err(_) => {
            let s = LauncherSettings::default();
            let _ = save_settings(data_dir, &s);
            return s;
        }
    };
    serde_json::from_str(&content).unwrap_or_else(|_| {
        let s = LauncherSettings::default();
        let _ = save_settings(data_dir, &s);
        s
    })
}

pub fn save_settings(data_dir: &Path, settings: &LauncherSettings) -> Result<(), String> {
    let json = serde_json::to_string_pretty(settings).map_err(|e| format!("Ошибка: {e}"))?;
    std::fs::write(settings_path(data_dir), json).map_err(|e| format!("Ошибка записи: {e}"))
}

// ─── Stats cache ───────────────────────────────────────────

pub fn load_cached_stats(data_dir: &Path) -> Option<PlayerStats> {
    let content = std::fs::read_to_string(data_dir.join("cached-stats.json")).ok()?;
    serde_json::from_str(&content).ok()
}

pub fn save_cached_stats(data_dir: &Path, stats: &PlayerStats) {
    let _ = std::fs::write(
        data_dir.join("cached-stats.json"),
        serde_json::to_string(stats).unwrap_or_default(),
    );
}

// ─── Game dir ──────────────────────────────────────────────

pub fn game_dir(data_dir: &Path) -> PathBuf {
    data_dir.join("minecraft").join("game")
}

pub fn managed_files_path(game_dir: &Path) -> PathBuf {
    game_dir.join("managed-files.json")
}

pub fn mod_choices_path(data_dir: &Path) -> PathBuf {
    data_dir.join("mod-choices.json")
}
