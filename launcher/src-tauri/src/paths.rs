// Определение режима запуска (портативный/установленный) и путей данных.
//
// Портативный режим: рядом с исполняемым файлом лежит маркер `portable.txt`
// (или `.portable`). Тогда все данные лаунчера хранятся в папке `data`
// рядом с exe — ничего не пишется в систему, можно носить на флешке.
//
// Установленный режим (маркера нет): данные в системной папке приложения
// (на Windows — %APPDATA%\<bundle-id>), как у обычной программы.

use std::path::{Path, PathBuf};

use tauri::{AppHandle, Manager};

#[derive(serde::Serialize, serde::Deserialize)]
struct DataDirectoryLocation {
    path: PathBuf,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LaunchMode {
    Portable,
    Installed,
}

impl LaunchMode {
    pub fn as_str(self) -> &'static str {
        match self {
            LaunchMode::Portable => "portable",
            LaunchMode::Installed => "installed",
        }
    }
}

/// Папка, в которой лежит исполняемый файл.
pub fn exe_dir() -> Option<PathBuf> {
    std::env::current_exe()
        .ok()?
        .parent()
        .map(|p| p.to_path_buf())
}

/// Есть ли рядом с exe маркер портативного режима.
pub fn portable_marker_exists() -> bool {
    exe_dir()
        .map(|d| {
            d.join("portable.txt").exists()
                || d.join(".portable").exists()
                // Частая опечатка; поддерживаем, чтобы лаунчер не уходил
                // неожиданно в installed-режим.
                || d.join(".protable").exists()
        })
        .unwrap_or(false)
}

/// Текущий режим запуска.
pub fn launch_mode() -> LaunchMode {
    if portable_marker_exists() {
        LaunchMode::Portable
    } else {
        LaunchMode::Installed
    }
}

/// Базовая папка данных без пользовательского выбора.
pub fn default_data_dir(app: &AppHandle) -> PathBuf {
    match launch_mode() {
        LaunchMode::Portable => exe_dir().unwrap_or_else(|| PathBuf::from(".")).join("data"),
        LaunchMode::Installed => app
            .path()
            .app_data_dir()
            .unwrap_or_else(|_| PathBuf::from(".")),
    }
}

/// Указатель пользовательской папки держим вне самих данных. Иначе после
/// переноса лаунчер не смог бы узнать новое место при следующем старте.
fn location_file(app: &AppHandle) -> PathBuf {
    match launch_mode() {
        LaunchMode::Portable => exe_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join("data-location.json"),
        LaunchMode::Installed => app
            .path()
            // На Windows app_config_dir и app_data_dir могут совпадать.
            // Cache dir отделён от игровых данных и переживает их перенос.
            .app_cache_dir()
            .unwrap_or_else(|_| default_data_dir(app))
            .join("data-location.json"),
    }
}

pub fn configured_data_dir(app: &AppHandle) -> Option<PathBuf> {
    let raw = std::fs::read_to_string(location_file(app)).ok()?;
    let location: DataDirectoryLocation = serde_json::from_str(&raw).ok()?;
    location.path.is_absolute().then_some(location.path)
}

/// Корневая папка данных лаунчера для текущего режима.
/// Гарантированно создаётся при первом обращении.
pub fn data_dir(app: &AppHandle) -> PathBuf {
    let dir = configured_data_dir(app).unwrap_or_else(|| default_data_dir(app));
    let _ = std::fs::create_dir_all(&dir);
    dir
}

pub fn selection_required(app: &AppHandle) -> bool {
    configured_data_dir(app).is_none() && !directory_has_entries(&default_data_dir(app))
}

pub fn set_data_dir(app: &AppHandle, dir: &Path) -> Result<(), String> {
    let parent = location_file(app)
        .parent()
        .map(Path::to_path_buf)
        .ok_or("не удалось определить папку конфигурации")?;
    std::fs::create_dir_all(parent).map_err(|e| format!("не удалось создать папку конфигурации: {e}"))?;
    let json = serde_json::to_string_pretty(&DataDirectoryLocation {
        path: dir.to_path_buf(),
    })
    .map_err(|e| e.to_string())?;
    std::fs::write(location_file(app), json)
        .map_err(|e| format!("не удалось сохранить расположение папки данных: {e}"))
}

fn directory_has_entries(dir: &Path) -> bool {
    std::fs::read_dir(dir)
        .ok()
        .and_then(|mut entries| entries.next())
        .is_some()
}

/// Путь к файлу настроек.
pub fn settings_file(app: &AppHandle) -> PathBuf {
    data_dir(app).join("settings.json")
}

/// Путь к сохранённой сессии лаунчера.
pub fn session_file(app: &AppHandle) -> PathBuf {
    data_dir(app).join("session.json")
}

/// Папка кеша скинов (по UUID).
pub fn skin_cache_dir(app: &AppHandle) -> PathBuf {
    let dir = data_dir(app).join("skin-cache");
    let _ = std::fs::create_dir_all(&dir);
    dir
}
