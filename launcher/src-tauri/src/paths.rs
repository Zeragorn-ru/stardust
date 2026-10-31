// Определение режима запуска (портативный/установленный) и путей данных.
//
// Портативный режим: рядом с исполняемым файлом лежит маркер `portable.txt`
// (или `.portable`). Тогда все данные лаунчера хранятся в папке `data`
// рядом с exe — ничего не пишется в систему, можно носить на флешке.
//
// Установленный режим (маркера нет): данные в системной папке приложения
// (на Windows — %APPDATA%\<bundle-id>), как у обычной программы.

use std::path::{Path, PathBuf};

use sha1::{Digest, Sha1};

/// Папка привязана к сборке и совместимому игровому ядру, но не к версии
/// сборки или загрузчика: обычные обновления модов не меняют игровой каталог.
/// На старом сервере вместо buildId используется хеш имени.
fn build_key(manifest: &protocol::Manifest) -> String {
    let build = match manifest.build_id.filter(|id| *id > 0) {
        Some(id) => format!("build-{id}"),
        None => format!("name-{:x}", Sha1::digest(manifest.name.as_bytes())),
    };
    let kind = match manifest.loader.kind {
        protocol::LoaderKind::Vanilla => "vanilla",
        protocol::LoaderKind::Fabric => "fabric",
        protocol::LoaderKind::Quilt => "quilt",
        protocol::LoaderKind::Forge => "forge",
        protocol::LoaderKind::NeoForge => "neoforge",
    };
    let version_hash = Sha1::digest(manifest.loader.minecraft.as_bytes());
    format!("{build}-{kind}-{version_hash:x}")
}

pub fn game_dir(data_dir: &Path, manifest: Option<&protocol::Manifest>) -> PathBuf {
    let root = data_dir.join("minecraft");
    match manifest {
        Some(m) => root.join("instances").join(build_key(m)).join("game"),
        None => root.join("instances").join("unmanaged").join("game"),
    }
}

pub fn cached_game_dir(data_dir: &Path) -> PathBuf {
    let manifest = std::fs::read(data_dir.join("cached-manifest.json"))
        .ok()
        .and_then(|bytes| serde_json::from_slice::<protocol::Manifest>(&bytes).ok());
    game_dir(data_dir, manifest.as_ref())
}

/// Старый общий каталог не содержит идентификатора сборки. Не угадываем
/// владельца и не переносим данные: игрок может скопировать нужные файлы.
pub fn prepare_game_dir(
    data_dir: &Path,
    manifest: Option<&protocol::Manifest>,
) -> Result<PathBuf, String> {
    let target = game_dir(data_dir, manifest);
    std::fs::create_dir_all(&target).map_err(|e| format!("Не удалось создать папку игры: {e}"))?;
    canonical_clean(&target)
}

use tauri::{AppHandle, Manager};

/// On Windows `fs::canonicalize` / `std::env::current_exe` return extended-
/// length paths (`\\?\...`) which some Java/Minecraft tooling cannot handle.
/// This strips that prefix while keeping the path absolute and resolved.
#[cfg(windows)]
pub fn strip_extended_prefix(path: PathBuf) -> PathBuf {
    let s = path.to_string_lossy();
    if let Some(rest) = s.strip_prefix(r"\\?\") {
        let bytes = rest.as_bytes();
        // Drive letter: C:\...
        if bytes.len() >= 3 && bytes[1] == b':' && bytes[2] == b'\\' {
            return PathBuf::from(rest);
        }
        // UNC: \\?\UNC\server\share → \\server\share
        if let Some(stripped) = rest.strip_prefix("UNC\\") {
            return PathBuf::from(format!("\\{}", stripped));
        }
    }
    path
}

#[cfg(not(windows))]
pub fn strip_extended_prefix(path: PathBuf) -> PathBuf {
    path
}

/// Canonicalize + strip extended-length prefix on Windows.
pub fn canonical_clean(path: &Path) -> Result<PathBuf, String> {
    let canonical = std::fs::canonicalize(path).map_err(|e| {
        format!(
            "Не удалось определить абсолютный путь {}: {e}",
            path.display()
        )
    })?;
    Ok(strip_extended_prefix(canonical))
}

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
        .map(|p| strip_extended_prefix(p.to_path_buf()))
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

/// Файл, в котором хранится указатель на пользовательскую папку данных.
/// Нужен для диагностических сообщений и не является частью игровых данных.
pub fn data_location_path(app: &AppHandle) -> PathBuf {
    location_file(app)
}

/// Выборы относятся к тому же экземпляру, что и игровые файлы. Храним их
/// рядом с game/, чтобы просмотр профилей не создавал игровую папку заранее.
pub fn modpack_settings(data_dir: &Path, manifest: &protocol::Manifest) -> (PathBuf, PathBuf) {
    let instance = data_dir.join("minecraft").join("instances").join(build_key(manifest));
    (instance.join("mod-choices.json"), instance.join("selected-profile.json"))
}

pub fn configured_data_dir(app: &AppHandle) -> Option<PathBuf> {
    let raw = std::fs::read_to_string(location_file(app)).ok()?;
    let location: DataDirectoryLocation = serde_json::from_str(&raw).ok()?;
    let path = strip_extended_prefix(location.path);
    path.is_absolute().then_some(path)
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
    std::fs::create_dir_all(parent)
        .map_err(|e| format!("не удалось создать папку конфигурации: {e}"))?;
    let clean = strip_extended_prefix(dir.to_path_buf());
    let json = serde_json::to_string_pretty(&DataDirectoryLocation { path: clean })
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

/// Файл с Bearer-токеном сессии (JSON `{"token": ...}`).
///
/// Храним на диске, а не в системном keyring: на macOS связка ключей для
/// неподписанного приложения запрашивает доступ при каждом запуске, что
/// ломает автологин. Файл создаётся с правами 0600.
pub fn session_token_file(app: &AppHandle) -> PathBuf {
    data_dir(app).join("session-token.json")
}

/// Папка кеша скинов (по UUID).
pub fn skin_cache_dir(app: &AppHandle) -> PathBuf {
    let dir = data_dir(app).join("skin-cache");
    let _ = std::fs::create_dir_all(&dir);
    dir
}

#[cfg(test)]
mod game_directory_tests {
    use super::*;

    fn manifest(id: Option<i64>, name: &str) -> protocol::Manifest {
        serde_json::from_value(serde_json::json!({
            "buildId": id, "name": name, "version": "1",
            "loader": {"minecraft": "1.21.1", "kind": "fabric", "version": "0.16.14"},
            "files": []
        }))
        .unwrap()
    }

    fn temp() -> PathBuf {
        let path = std::env::temp_dir().join(format!(
            "stardust-instances-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&path).unwrap();
        path
    }

    #[test]
    fn unknown_legacy_is_preserved_and_builds_are_isolated() {
        let root = temp();
        let legacy = root.join("minecraft/game");
        std::fs::create_dir_all(legacy.join("saves/world")).unwrap();
        std::fs::write(legacy.join("saves/world/level.dat"), b"world").unwrap();
        std::fs::write(legacy.join("managed-files.json"), b"state").unwrap();
        let first = prepare_game_dir(&root, Some(&manifest(Some(1), "A"))).unwrap();
        let second = prepare_game_dir(&root, Some(&manifest(Some(2), "B"))).unwrap();
        assert_ne!(first, second);
        assert!(!first.join("saves").exists());
        assert!(!second.join("saves").exists());
        assert_eq!(
            std::fs::read(legacy.join("saves/world/level.dat")).unwrap(),
            b"world"
        );
        assert_eq!(
            std::fs::read(legacy.join("managed-files.json")).unwrap(),
            b"state"
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn game_directory_tracks_minecraft_and_loader_but_not_modpack_updates() {
        let root = temp();
        let original = manifest(Some(42), "test");
        let path = game_dir(&root, Some(&original));
        let mut updated = original.clone();
        updated.version = "2".into();
        updated.loader.version = "0.17.0".into();
        assert_eq!(path, game_dir(&root, Some(&updated)));
        updated.loader.minecraft = "1.21.4".into();
        let newer_mc = game_dir(&root, Some(&updated));
        assert_ne!(path, newer_mc);
        updated.loader.kind = protocol::LoaderKind::NeoForge;
        assert_ne!(newer_mc, game_dir(&root, Some(&updated)));
        updated.loader.minecraft = original.loader.minecraft.clone();
        assert_ne!(path, game_dir(&root, Some(&updated)));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn id_is_stable_and_old_cache_without_id_is_supported() {
        let root = temp();
        let old: protocol::Manifest = serde_json::from_str(r#"{"name":"../../unsafe","version":"1","loader":{"minecraft":"1.21.1","kind":"fabric","version":"0.16.14"},"files":[]}"#).unwrap();
        assert!(old.build_id.is_none());
        let old_dir = prepare_game_dir(&root, Some(&old)).unwrap();
        std::fs::write(old_dir.join("options.txt"), b"settings").unwrap();
        let new = manifest(Some(42), "../../unsafe");
        let new_dir = prepare_game_dir(&root, Some(&new)).unwrap();
        assert_ne!(old_dir, new_dir);
        assert_eq!(
            std::fs::read(old_dir.join("options.txt")).unwrap(),
            b"settings"
        );
        assert_eq!(
            game_dir(&root, Some(&new)),
            game_dir(&root, Some(&manifest(Some(42), "renamed")))
        );
        std::fs::remove_dir_all(root).unwrap();
    }
}
