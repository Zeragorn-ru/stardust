//! Определение путей данных (общих с Tauri лаунчером).

use std::path::PathBuf;

/// App ID — совпадает с Tauri bundle identifier.
const APP_ID: &str = "com.stardust.launcher";

/// Корневая папка данных лаунчера.
///
/// - Windows: `%APPDATA%\com.stardust.launcher\`
/// - Linux: `~/.local/share/com.stardust.launcher/`
/// - macOS: `~/Library/Application Support/com.stardust.launcher/`
pub fn data_dir() -> PathBuf {
    #[cfg(target_os = "windows")]
    {
        let appdata =
            std::env::var("APPDATA").unwrap_or_else(|_| "C:\\".to_string());
        PathBuf::from(appdata).join(APP_ID)
    }

    #[cfg(target_os = "linux")]
    {
        let xdg = std::env::var("XDG_DATA_HOME")
            .unwrap_or_else(|_| {
                let home = std::env::var("HOME").unwrap_or_default();
                format!("{home}/.local/share")
            });
        PathBuf::from(xdg).join(APP_ID)
    }

    #[cfg(target_os = "macos")]
    {
        let home = std::env::var("HOME").unwrap_or_default();
        PathBuf::from(home)
            .join("Library")
            .join("Application Support")
            .join(APP_ID)
    }

    #[cfg(not(any(target_os = "windows", target_os = "linux", target_os = "macos")))]
    {
        PathBuf::from(".")
    }
}

/// Путь к файлу настроек.
pub fn settings_file() -> PathBuf {
    data_dir().join("settings.json")
}

/// Путь к кешу статистики.
pub fn cached_stats_file() -> PathBuf {
    data_dir().join("cached-stats.json")
}

/// Путь к кешу манифеста.
pub fn cached_manifest_file() -> PathBuf {
    data_dir().join("cached-manifest.json")
}

/// Папка кеша скинов.
pub fn skin_cache_dir() -> PathBuf {
    let dir = data_dir().join("skin-cache");
    let _ = std::fs::create_dir_all(&dir);
    dir
}

/// Путь к папке.minecraft/game (откуда запускается Java).
pub fn game_dir() -> PathBuf {
    data_dir().join("minecraft").join("game")
}
