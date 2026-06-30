//! Синхронизация модпака — скачивание файлов из манифеста.

use sha1::{Digest, Sha1};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use crate::api::{Manifest, ManifestFile};

const MAX_ATTEMPTS: u32 = 5;
const CHUNK_TIMEOUT_SECS: u64 = 30;

/// Состояние管理'd файлов: путь (относительный) -> sha1.
pub type ManagedState = BTreeMap<String, String>;

/// Прочитать managed-files.json.
pub fn load_managed(game_dir: &Path) -> ManagedState {
    let path = game_dir.join("managed-files.json");
    std::fs::read_to_string(&path)
        .ok()
        .and_then(|c| serde_json::from_str(&c).ok())
        .unwrap_or_default()
}

/// Записать managed-files.json.
pub fn save_managed(game_dir: &Path, state: &ManagedState) {
    let path = game_dir.join("managed-files.json");
    let json = serde_json::to_string_pretty(state).unwrap_or_default();
    let _ = std::fs::write(&path, json);
}

/// Прочитать mod-choices.json (включение/отключение модов).
pub fn load_choices(data_dir: &Path) -> BTreeMap<String, bool> {
    let path = data_dir.join("mod-choices.json");
    std::fs::read_to_string(&path)
        .ok()
        .and_then(|c| serde_json::from_str(&c).ok())
        .unwrap_or_default()
}

/// Записать mod-choices.json.
pub fn save_choices(data_dir: &Path, choices: &BTreeMap<String, bool>) {
    let path = data_dir.join("mod-choices.json");
    let json = serde_json::to_string_pretty(choices).unwrap_or_default();
    let _ = std::fs::write(&path, json);
}

/// Вычислить SHA-1 файла.
pub fn file_sha1(path: &Path) -> Option<String> {
    let bytes = std::fs::read(path).ok()?;
    let mut hasher = Sha1::new();
    hasher.update(&bytes);
    let result = hasher.finalize();
    Some(hex::encode(result))
}

/// Синхронизация модпака.
/// Возвращает количество скачанных файлов.
pub async fn sync(
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

        // Проверяем.enabled state для опциональных модов.
        let enabled = if file.optional {
            choices.get(&file.mod_id.clone().unwrap_or_default())
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

        // Файл уже на месте с правильным sha1.
        if active_path.exists() {
            if let Some(sha) = file_sha1(&active_path) {
                if sha == file.sha1 {
                    desired.insert(file.path.clone(), file.sha1.clone());
                    // Убираем дубликат если есть.
                    let _ = std::fs::remove_file(&inactive_path);
                    continue;
                }
            }
        }

        // Файл неактивен но SHA совпадает — просто переименовать.
        if inactive_path.exists() {
            if let Some(sha) = file_sha1(&inactive_path) {
                if sha == file.sha1 {
                    let _ = tokio::fs::rename(&inactive_path, &active_path).await;
                    desired.insert(file.path.clone(), file.sha1.clone());
                    continue;
                }
            }
        }

        // Скачиваем.
        downloads.push((file.clone(), active_path));
    }

    // Скачиваем файлы параллельно.
    let sem = std::sync::Arc::new(tokio::sync::Semaphore::new(concurrency as usize));
    let mut handles = Vec::new();

    for (file, target) in downloads {
        let sem = sem.clone();
        let url = file.url.clone();
        let sha1_expected = file.sha1.clone();
        let path = file.path.clone();

        handles.push(tokio::spawn(async move {
            let _permit = sem.acquire().await.unwrap();
            for attempt in 1..=MAX_ATTEMPTS {
                match download_file(&url).await {
                    Ok(bytes) => {
                        // Проверяем SHA-1.
                        let mut hasher = Sha1::new();
                        hasher.update(&bytes);
                        let sha1_actual = hex::encode(hasher.finalize());

                        if sha1_actual != sha1_expected {
                            if attempt == MAX_ATTEMPTS {
                                return Err(format!(
                                    "SHA-1 не совпадает для {}: ожидается {sha1_expected}, получено {sha1_actual}",
                                    path
                                ));
                            }
                            continue;
                        }

                        // Создаём директорию.
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
            }
            Ok(Err(e)) => {
                eprintln!("modpack sync: {e}");
            }
            Err(e) => {
                eprintln!("modpack sync task: {e}");
            }
        }
    }

    // Cleanup: удаляем файлы которые были managed но больше не в манифесте.
    for (path, sha) in &managed {
        if !new_managed.contains_key(path) {
            let file_path = game_dir.join(path);
            // Удаляем только если sha не изменился (пользователь не редактировал).
            if file_sha1(&file_path).as_deref() == Some(sha.as_str()) {
                let _ = tokio::fs::remove_file(&file_path).await;
            }
            // Также удаляем .dis версию.
            let dis_path = game_dir.join(format!("{path}.dis"));
            if file_sha1(&dis_path).as_deref() == Some(sha.as_str()) {
                let _ = tokio::fs::remove_file(&dis_path).await;
            }
        }
    }

    save_managed(game_dir, &new_managed);
    Ok(downloaded)
}

async fn download_file(url: &str) -> Result<Vec<u8>, String> {
    let http = reqwest::Client::builder()
        .user_agent(format!("stardust-launcher/{}", env!("CARGO_PKG_VERSION")))
        .timeout(std::time::Duration::from_secs(CHUNK_TIMEOUT_SECS))
        .build()
        .map_err(|e| format!("HTTP: {e}"))?;

    let resp = http.get(url).send().await.map_err(|e| format!("Сеть: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("HTTP {}", resp.status()));
    }
    resp.bytes()
        .await
        .map(|b| b.to_vec())
        .map_err(|e| format!("Чтение: {e}"))
}
