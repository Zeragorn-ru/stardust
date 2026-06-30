//! Updater — проверка GitHub Releases + скачивание.

use serde::Deserialize;
use std::path::PathBuf;

const RELEASES_URL: &str = "https://api.github.com/repos/Zeragorn-ru/stardust/releases";
const CURRENT_VERSION: &str = env!("CARGO_PKG_VERSION");
const MAX_DOWNLOAD_ATTEMPTS: u32 = 3;

#[derive(Debug, Clone)]
pub struct UpdateInfo {
    pub available: bool,
    pub current_version: String,
    pub version: String,
    pub notes: String,
    pub download_url: String,
    pub asset_name: String,
}

#[derive(Debug, Deserialize)]
struct GhRelease {
    tag_name: String,
    body: Option<String>,
    assets: Vec<GhAsset>,
}

#[derive(Debug, Deserialize)]
struct GhAsset {
    name: String,
    browser_download_url: String,
    size: u64,
}

/// Проверить наличие обновления.
pub async fn check_update() -> UpdateInfo {
    let current = CURRENT_VERSION.to_string();
    let http = match reqwest::Client::builder()
        .user_agent("stardust-native-updater")
        .timeout(std::time::Duration::from_secs(15))
        .build()
    {
        Ok(c) => c,
        Err(_) => {
            return UpdateInfo {
                available: false,
                current_version: current,
                version: String::new(),
                notes: String::new(),
                download_url: String::new(),
                asset_name: String::new(),
            };
        }
    };

    let resp = match http.get(RELEASES_URL).send().await {
        Ok(r) => r,
        Err(_) => {
            return UpdateInfo {
                available: false,
                current_version: current,
                version: String::new(),
                notes: String::new(),
                download_url: String::new(),
                asset_name: String::new(),
            };
        }
    };

    let releases: Vec<GhRelease> = match resp.json().await {
        Ok(r) => r,
        Err(_) => {
            return UpdateInfo {
                available: false,
                current_version: current,
                version: String::new(),
                notes: String::new(),
                download_url: String::new(),
                asset_name: String::new(),
            };
        }
    };

    // Ищем первый релиз новее текущего.
    for release in &releases {
        let tag = release.tag_name.trim_start_matches('v');
        if is_newer(tag, &current) {
            // Ищем подходящий ассет.
            let asset = release.assets.iter().find(|a| {
                a.name.contains("native")
                    || a.name.ends_with(".exe") && !a.name.contains("setup")
                    || a.name.ends_with(".AppImage")
            });

            if let Some(asset) = asset {
                return UpdateInfo {
                    available: true,
                    current_version: current,
                    version: tag.to_string(),
                    notes: release.body.clone().unwrap_or_default(),
                    download_url: asset.browser_download_url.clone(),
                    asset_name: asset.name.clone(),
                };
            }
        }
    }

    UpdateInfo {
        available: false,
        current_version: current,
        version: String::new(),
        notes: String::new(),
        download_url: String::new(),
        asset_name: String::new(),
    }
}

/// Скачать обновление во временную папку.
pub async fn download_update(url: &str) -> Result<PathBuf, String> {
    let http = reqwest::Client::builder()
        .user_agent("stardust-native-updater")
        .timeout(std::time::Duration::from_secs(120))
        .build()
        .map_err(|e| format!("HTTP клиент: {e}"))?;

    for attempt in 1..=MAX_DOWNLOAD_ATTEMPTS {
        match http.get(url).send().await {
            Ok(resp) => {
                if !resp.status().is_success() {
                    return Err(format!("HTTP {}", resp.status()));
                }
                let bytes = resp
                    .bytes()
                    .await
                    .map_err(|e| format!("Чтение: {e}"))?;

                let filename = url.rsplit('/').next().unwrap_or("update.bin");
                let temp_dir = std::env::temp_dir();
                let path = temp_dir.join(filename);
                std::fs::write(&path, &bytes)
                    .map_err(|e| format!("Запись: {e}"))?;
                return Ok(path);
            }
            Err(e) => {
                if attempt == MAX_DOWNLOAD_ATTEMPTS {
                    return Err(format!("Сеть (попытка {attempt}): {e}"));
                }
                let delay = 2u64.pow(attempt);
                tokio::time::sleep(std::time::Duration::from_secs(delay)).await;
            }
        }
    }
    Err("Не удалось скачать".to_string())
}

/// Сравнение версий: true если `new_ver` > `current_ver`.
fn is_newer(new_ver: &str, current_ver: &str) -> bool {
    let parse = |v: &str| -> Vec<u32> {
        v.split('-')
            .next()
            .unwrap_or(v)
            .split('.')
            .filter_map(|s| s.parse().ok())
            .collect()
    };
    let new_parts = parse(new_ver);
    let cur_parts = parse(current_ver);
    new_parts > cur_parts
}
