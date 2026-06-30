//! Modpack sync — download files from manifest with progress.

use sha1::{Digest, Sha1};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use crate::api::{Manifest, ManifestFile};
use crate::progress::Progress;

const MAX_ATTEMPTS: u32 = 5;
const CHUNK_TIMEOUT_SECS: u64 = 30;

pub type ManagedState = BTreeMap<String, String>;

pub fn load_managed(game_dir: &Path) -> ManagedState {
    let path = game_dir.join("managed-files.json");
    std::fs::read_to_string(&path)
        .ok()
        .and_then(|c| serde_json::from_str(&c).ok())
        .unwrap_or_default()
}

pub fn save_managed(game_dir: &Path, state: &ManagedState) {
    let path = game_dir.join("managed-files.json");
    let json = serde_json::to_string_pretty(state).unwrap_or_default();
    let _ = std::fs::write(&path, json);
}

pub fn load_choices(data_dir: &Path) -> BTreeMap<String, bool> {
    let path = data_dir.join("mod-choices.json");
    std::fs::read_to_string(&path)
        .ok()
        .and_then(|c| serde_json::from_str(&c).ok())
        .unwrap_or_default()
}

pub fn save_choices(data_dir: &Path, choices: &BTreeMap<String, bool>) {
    let path = data_dir.join("mod-choices.json");
    let json = serde_json::to_string_pretty(choices).unwrap_or_default();
    let _ = std::fs::write(&path, json);
}

pub fn file_sha1(path: &Path) -> Option<String> {
    let bytes = std::fs::read(path).ok()?;
    let mut hasher = Sha1::new();
    hasher.update(&bytes);
    let result = hasher.finalize();
    Some(hex::encode(result))
}

/// Sync modpack with progress support (called from play flow).
pub async fn sync_with_progress(
    progress: &Progress,
    http: &reqwest::Client,
    data_dir: &Path,
    game_dir: &Path,
    concurrency: u32,
) -> Result<usize, String> {
    let manifest = crate::api::fetch_manifest(data_dir).await?;
    let manifest = match manifest {
        Some(m) => m,
        None => return Ok(0),
    };
    sync(progress, http, data_dir, game_dir, concurrency, &manifest).await
}

/// Sync modpack — core logic with optional mod toggle, overwrite detection,
/// stale cleanup.
pub async fn sync(
    progress: &Progress,
    http: &reqwest::Client,
    data_dir: &Path,
    game_dir: &Path,
    concurrency: u32,
    manifest: &Manifest,
) -> Result<usize, String> {
    let _ = tokio::fs::create_dir_all(game_dir).await;

    let managed = load_managed(game_dir);
    let choices = load_choices(data_dir);
    let mut desired: ManagedState = BTreeMap::new();
    let mut downloads: Vec<(ManifestFile, PathBuf)> = Vec::new();

    for file in &manifest.files {
        if file.side != "client" && file.side != "all" {
            continue;
        }

        let file_path = game_dir.join(&file.path);

        // Check enabled state for optional mods
        let enabled = if file.optional {
            choices
                .get(&file.mod_id.clone().unwrap_or_default())
                .copied()
                .unwrap_or(file.enabled_by_default)
        } else {
            true
        };

        let active_path = if enabled {
            file_path.clone()
        } else {
            game_dir.join(format!("{}.dis", file.path))
        };
        let inactive_path = if enabled {
            game_dir.join(format!("{}.dis", file.path))
        } else {
            file_path.clone()
        };

        // File already correct with matching sha1
        if active_path.exists() {
            if let Some(sha) = file_sha1(&active_path) {
                if sha == file.sha1 {
                    desired.insert(file.path.clone(), file.sha1.clone());
                    let _ = std::fs::remove_file(&inactive_path);
                    continue;
                }
            }
        }

        // Mandatory config with overwrite=false and previously managed — skip
        if !file.overwrite
            && !file.optional
            && managed.contains_key(&file.path)
        {
            desired.insert(file.path.clone(), file.sha1.clone());
            continue;
        }

        // File under wrong name (mod toggled) — just rename
        if inactive_path.exists() {
            if let Some(sha) = file_sha1(&inactive_path) {
                if sha == file.sha1 {
                    let _ = tokio::fs::rename(&inactive_path, &active_path).await;
                    desired.insert(file.path.clone(), file.sha1.clone());
                    continue;
                }
            }
        }

        // Need download
        downloads.push((file.clone(), active_path));
    }

    let total = downloads.len();
    progress.set_total_items(total);
    if total == 0 {
        progress.set_stage_fraction(1.0);
    }

    // Download files in parallel
    let sem = std::sync::Arc::new(tokio::sync::Semaphore::new(concurrency as usize));
    let mut handles = Vec::new();

    for (file, target) in downloads {
        let sem = sem.clone();
        let url = file.url.clone();
        let sha1_expected = file.sha1.clone();
        let path = file.path.clone();
        let http = http.clone();

        handles.push(tokio::spawn(async move {
            let _permit = sem.acquire().await.unwrap();
            for attempt in 1..=MAX_ATTEMPTS {
                match download_file(&http, &url).await {
                    Ok(bytes) => {
                        let mut hasher = Sha1::new();
                        hasher.update(&bytes);
                        let sha1_actual = hex::encode(hasher.finalize());

                        if sha1_actual != sha1_expected {
                            if attempt == MAX_ATTEMPTS {
                                return Err(format!(
                                    "SHA-1 не совпадает для {path}"
                                ));
                            }
                            continue;
                        }

                        if let Some(parent) = target.parent() {
                            let _ = tokio::fs::create_dir_all(parent).await;
                        }
                        let _ = tokio::fs::write(&target, &bytes).await;
                        return Ok((path, sha1_expected));
                    }
                    Err(e) => {
                        if attempt == MAX_ATTEMPTS {
                            return Err(format!("Ошибка скачивания {url}: {e}"));
                        }
                        let delay = 2u64.pow(attempt).min(8);
                        tokio::time::sleep(std::time::Duration::from_secs(delay)).await;
                    }
                }
            }
            Err("Превышено число попыток".to_string())
        }));
    }

    let mut downloaded = 0;
    let mut new_managed = desired;
    for handle in handles {
        match handle.await {
            Ok(Ok((path, sha))) => {
                new_managed.insert(path, sha);
                downloaded += 1;
                progress.item_done(format!("Скачано: {downloaded}/{total}"));
            }
            Ok(Err(e)) => {
                eprintln!("modpack sync: {e}");
            }
            Err(e) => {
                eprintln!("modpack sync task: {e}");
            }
        }
    }

    // Cleanup stale files
    for (path, sha) in &managed {
        if !new_managed.contains_key(path) {
            let file_path = game_dir.join(path);
            if file_sha1(&file_path).as_deref() == Some(sha.as_str()) {
                let _ = tokio::fs::remove_file(&file_path).await;
            }
            let dis_path = game_dir.join(format!("{path}.dis"));
            if file_sha1(&dis_path).as_deref() == Some(sha.as_str()) {
                let _ = tokio::fs::remove_file(&dis_path).await;
            }
        }
    }

    save_managed(game_dir, &new_managed);
    Ok(downloaded)
}

async fn download_file(http: &reqwest::Client, url: &str) -> Result<Vec<u8>, String> {
    let resp = http.get(url).send().await.map_err(|e| format!("Сеть: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("HTTP {}", resp.status()));
    }
    resp.bytes()
        .await
        .map(|b| b.to_vec())
        .map_err(|e| format!("Чтение: {e}"))
}
