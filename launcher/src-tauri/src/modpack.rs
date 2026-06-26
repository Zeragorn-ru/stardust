// Синхронизация активной сборки (модпака) в игровой каталог.
//
// Перед запуском лаунчер тянет манифест активной сборки с admin-сервиса
// (`GET /manifest`) и раскладывает клиентские файлы (моды, конфиги, ресурсы)
// в game-dir. Сверка идёт по SHA-1: уже актуальные файлы не перекачиваются.
//
// Чтобы при обновлении сборки убирать удалённые из неё моды, лаунчер хранит
// рядом список ранее установленных им файлов (`managed-files.json`). Файлы,
// которых больше нет в манифесте, удаляются — но только если игрок их сам не
// менял (текущий SHA-1 совпадает с тем, что мы записали). Так пользовательские
// правки конфигов не теряются.

use std::collections::BTreeMap;
use std::path::{Component, Path, PathBuf};

use protocol::Manifest;
use serde::{Deserialize, Serialize};
use sha1::{Digest, Sha1};
use tauri::AppHandle;

use crate::minecraft::{download_to, emit_step};

/// Имя файла-реестра управляемых лаунчером файлов (лежит в game-dir).
const STATE_FILE: &str = "managed-files.json";

/// Реестр файлов, установленных лаунчером из сборки.
/// Ключ — путь относительно game-dir, значение — SHA-1 на момент установки.
#[derive(Debug, Default, Serialize, Deserialize)]
struct ManagedState {
    files: BTreeMap<String, String>,
}

/// Синхронизирует клиентские файлы активной сборки в `game_dir`.
///
/// Если активной сборки нет (404) — тихо выходит: игра запустится без модпака.
/// Сетевые/серверные ошибки пробрасываются, чтобы пользователь увидел причину.
pub async fn sync(app: &AppHandle, http: &reqwest::Client, game_dir: &Path) -> Result<(), String> {
    emit_step(app, "checking", "Проверяем сборку…", None);

    let manifest = match crate::backend::fetch_manifest(http).await? {
        Some(m) => m,
        None => {
            // Активной сборки нет — это нормальный режим (например, на старте
            // проекта). Запускаем ванильный NeoForge без модов.
            return Ok(());
        }
    };

    let mut state = read_state(game_dir);
    let mut desired: BTreeMap<String, String> = BTreeMap::new();

    // 1. Раскладываем нужные клиентские файлы.
    let entries = client_entries(&manifest);
    let total = entries.len();
    for (idx, entry) in entries.iter().enumerate() {
        let rel = sanitize_rel_path(&entry.path)
            .ok_or_else(|| format!("Недопустимый путь в манифесте: {}", entry.path))?;
        let target = game_dir.join(&rel);
        let rel_key = rel.to_string_lossy().replace('\\', "/");

        emit_step(
            app,
            "checking",
            format!("Сборка {}: файл {}/{}", manifest.version, idx + 1, total),
            Some((idx as f64) / (total.max(1) as f64)),
        );

        let up_to_date = file_sha1(&target)
            .map(|h| h.eq_ignore_ascii_case(&entry.sha1))
            .unwrap_or(false);

        if up_to_date {
            // Файл уже актуален — ничего не качаем.
            desired.insert(rel_key, entry.sha1.clone());
            continue;
        }

        // Если файл существует, его не велено перезаписывать и это уже наш
        // управляемый файл (был установлен ранее) — уважаем локальные правки
        // (типично для конфигов) и не трогаем.
        if target.exists() && !entry.overwrite && state.files.contains_key(&rel_key) {
            desired.insert(rel_key, entry.sha1.clone());
            continue;
        }

        let label = entry
            .display_name
            .clone()
            .unwrap_or_else(|| rel_key.clone());
        download_to(app, http, &entry.url, &target, &label).await?;

        // Проверяем целостность скачанного.
        match file_sha1(&target) {
            Some(got) if got.eq_ignore_ascii_case(&entry.sha1) => {}
            Some(got) => {
                return Err(format!(
                    "Контрольная сумма {rel_key} не совпала (ожидалась {}, получена {got})",
                    entry.sha1
                ));
            }
            None => return Err(format!("Не удалось прочитать скачанный файл {rel_key}")),
        }

        desired.insert(rel_key, entry.sha1.clone());
    }

    // 2. Убираем файлы, которые лаунчер ставил раньше, но в новой сборке их
    //    больше нет (или опциональный мод выключили). Удаляем только если
    //    игрок файл сам не менял.
    cleanup_stale(game_dir, &state, &desired);

    // 3. Сохраняем новый реестр.
    state.files = desired;
    write_state(game_dir, &state);

    Ok(())
}

/// Клиентские файлы, которые должны присутствовать: все обязательные плюс
/// включённые опциональные. Пока выбор игрока не реализован в UI — опциональные
/// моды берём по `enabled_by_default`.
fn client_entries(manifest: &Manifest) -> Vec<&protocol::FileEntry> {
    manifest
        .client_files()
        .filter(|f| !f.optional || f.enabled_by_default)
        .collect()
}

/// Удаляет ранее установленные лаунчером файлы, отсутствующие в `desired`,
/// если их текущий SHA-1 совпадает с записанным (игрок не менял).
fn cleanup_stale(game_dir: &Path, state: &ManagedState, desired: &BTreeMap<String, String>) {
    for (rel_key, recorded_sha1) in &state.files {
        if desired.contains_key(rel_key) {
            continue;
        }
        let Some(rel) = sanitize_rel_path(rel_key) else {
            continue;
        };
        let path = game_dir.join(&rel);
        let unchanged = file_sha1(&path)
            .map(|h| h.eq_ignore_ascii_case(recorded_sha1))
            .unwrap_or(false);
        if unchanged {
            let _ = std::fs::remove_file(&path);
            remove_empty_parents(game_dir, &path);
        }
    }
}

/// Удаляет опустевшие родительские каталоги вверх до game-dir (не включая его).
fn remove_empty_parents(game_dir: &Path, file: &Path) {
    let mut dir = file.parent();
    while let Some(d) = dir {
        if d == game_dir || !d.starts_with(game_dir) {
            break;
        }
        if std::fs::remove_dir(d).is_err() {
            break; // каталог не пуст или ошибка — дальше не идём
        }
        dir = d.parent();
    }
}

/// SHA-1 файла в hex, либо `None`, если файла нет/не читается.
fn file_sha1(path: &Path) -> Option<String> {
    use std::io::Read;
    let mut file = std::fs::File::open(path).ok()?;
    let mut hasher = Sha1::new();
    let mut buf = [0u8; 64 * 1024];
    loop {
        let n = file.read(&mut buf).ok()?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    let digest = hasher.finalize();
    let mut out = String::with_capacity(40);
    for b in digest {
        out.push_str(&format!("{b:02x}"));
    }
    Some(out)
}

/// Приводит путь из манифеста к безопасному относительному пути.
/// Отклоняет абсолютные пути и любые `..`-выходы за пределы game-dir.
fn sanitize_rel_path(raw: &str) -> Option<PathBuf> {
    let raw = raw.trim().replace('\\', "/");
    if raw.is_empty() {
        return None;
    }
    let candidate = PathBuf::from(&raw);
    let mut clean = PathBuf::new();
    for comp in candidate.components() {
        match comp {
            Component::Normal(part) => clean.push(part),
            // Любой из этих компонентов означает попытку выйти за каталог или
            // абсолютный путь — отвергаем целиком.
            Component::ParentDir
            | Component::RootDir
            | Component::Prefix(_)
            | Component::CurDir => return None,
        }
    }
    if clean.as_os_str().is_empty() {
        None
    } else {
        Some(clean)
    }
}

fn state_path(game_dir: &Path) -> PathBuf {
    game_dir.join(STATE_FILE)
}

fn read_state(game_dir: &Path) -> ManagedState {
    std::fs::read_to_string(state_path(game_dir))
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn write_state(game_dir: &Path, state: &ManagedState) {
    if let Ok(json) = serde_json::to_string_pretty(state) {
        let _ = std::fs::write(state_path(game_dir), json);
    }
}
