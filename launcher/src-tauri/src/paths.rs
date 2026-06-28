// Определение режима запуска (портативный/установленный) и путей данных.
//
// Портативный режим: рядом с исполняемым файлом лежит маркер `portable.txt`
// (или `.portable`). Тогда все данные лаунчера хранятся в папке `data`
// рядом с exe — ничего не пишется в систему, можно носить на флешке.
//
// Установленный режим (маркера нет): данные в системной папке приложения
// (на Windows — %APPDATA%\<bundle-id>), как у обычной программы.

use std::path::PathBuf;

use tauri::{AppHandle, Manager};

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

/// Корневая папка данных лаунчера для текущего режима.
/// Гарантированно создаётся при первом обращении.
pub fn data_dir(app: &AppHandle) -> PathBuf {
    let dir = match launch_mode() {
        LaunchMode::Portable => exe_dir().unwrap_or_else(|| PathBuf::from(".")).join("data"),
        LaunchMode::Installed => app
            .path()
            .app_data_dir()
            .unwrap_or_else(|_| PathBuf::from(".")),
    };
    let _ = std::fs::create_dir_all(&dir);
    dir
}

/// Путь к файлу настроек.
pub fn settings_file(app: &AppHandle) -> PathBuf {
    data_dir(app).join("settings.json")
}

/// Путь к сохранённой сессии лаунчера.
pub fn session_file(app: &AppHandle) -> PathBuf {
    data_dir(app).join("session.json")
}

