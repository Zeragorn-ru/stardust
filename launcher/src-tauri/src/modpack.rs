// Синхронизация активной сборки (модпака) в игровой каталог.
//
// Перед запуском лаунчер тянет манифест активной сборки с admin-сервиса
// (`GET /manifest`) и раскладывает ВСЕ клиентские файлы в game-dir. Сверка
// идёт по SHA-1: уже актуальные файлы не перекачиваются.
//
// Опциональные моды качаются всегда, но выключенные кладутся с суффиксом
// `.dis` (напр. `mods/sodium.jar.dis`) — Minecraft/NeoForge грузит только
// `.jar`, поэтому такой файл игнорируется. Включение/выключение мода в
// лаунчере — это просто переименование файла ± `.dis`, без перекачки. Выбор
// игрока хранится в `mod-choices.json` (data-dir) по `mod_id`; если выбора
// нет — берём `enabled_by_default` из манифеста.
//
// Чтобы при обновлении сборки убирать удалённые из неё моды, лаунчер хранит
// рядом список ранее установленных им файлов (`managed-files.json`). Файлы,
// которых больше нет в манифесте, удаляются — но только если игрок их сам не
// менял (текущий SHA-1 совпадает с тем, что мы записали). Так пользовательские
// правки конфигов не теряются.

use std::collections::BTreeMap;
use std::ffi::OsString;
use std::path::{Component, Path, PathBuf};

use futures_util::stream::{self, StreamExt};
use serde::{Deserialize, Serialize};
use sha1::{Digest, Sha1};

use crate::minecraft::download_to_counted;
use crate::progress::Progress;

/// Имя файла-реестра управляемых лаунчером файлов (лежит в game-dir).
const STATE_FILE: &str = "managed-files.json";
/// Имя файла с выбором игрока по опциональным модам (лежит в data-dir).
const CHOICES_FILE: &str = "mod-choices.json";
/// Суффикс, которым помечается выключенный мод (Minecraft его не грузит).
const DISABLED_SUFFIX: &str = ".dis";

/// Реестр файлов, установленных лаунчером из сборки.
/// Ключ — путь относительно game-dir (с суффиксом `.dis`, если мод выключен),
/// значение — SHA-1 содержимого на момент установки.
#[derive(Debug, Default, Serialize, Deserialize)]
struct ManagedState {
    files: BTreeMap<String, String>,
}

/// Опциональный мод для экрана управления в лаунчере.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OptionalMod {
    /// Стабильный идентификатор (`mod_id` из манифеста).
    pub mod_id: String,
    /// Человекочитаемое имя.
    pub name: String,
    /// Короткое описание, если задано.
    pub description: Option<String>,
    /// Включён ли мод у текущего игрока.
    pub enabled: bool,
    /// Размер файла в байтах.
    pub size: u64,
}

/// Стабильный ключ опционального мода для хранения выбора игрока.
///
/// Предпочитаем `mod_id` из манифеста, но если он не задан (файл просто
/// помечен опциональным без идентификатора) — используем путь файла. Путь
/// уникален в пределах сборки и стабилен, поэтому годится как ключ выбора и
/// гарантирует, что мод не пропадёт из списка в лаунчере.
fn mod_choice_key(entry: &protocol::FileEntry) -> String {
    entry.mod_id.clone().unwrap_or_else(|| entry.path.clone())
}

/// Синхронизирует клиентские файлы активной сборки в `game_dir`.
///
/// Если активной сборки нет (404) — тихо выходит: игра запустится без модпака.
/// Сетевые/серверные ошибки пробрасываются, чтобы пользователь увидел причину.
pub async fn sync(
    progress: &Progress,
    http: &reqwest::Client,
    data_dir: &Path,
    game_dir: &Path,
    concurrency: usize,
    manifest: Option<&protocol::Manifest>,
) -> Result<(), String> {
    progress.set_label("checking", "Проверяем сборку…");

    let manifest = match manifest {
        Some(m) => m,
        None => {
            progress.set_total_items(0);
            return Ok(());
        }
    };

    let choices = read_choices(data_dir);
    let mut state = read_state(game_dir);
    let mut desired: BTreeMap<String, String> = BTreeMap::new();

    let entries: Vec<_> = manifest.client_files().collect();
    let total = entries.len();
    progress.set_total_items(total);

    // Файл, который нужно скачать: содержимое нет ни под активным, ни под
    // неактивным именем. Резолвинг (sha-проверки, переименования) — быстрый и
    // последовательный; сами загрузки потом гоняем параллельно.
    struct DownloadJob {
        url: String,
        active: PathBuf,
        inactive: PathBuf,
        active_key: String,
        sha1: String,
        rel_key: String,
        label: String,
    }
    let mut jobs: Vec<DownloadJob> = Vec::new();

    for entry in entries.iter() {
        let rel = sanitize_rel_path(&entry.path)
            .ok_or_else(|| format!("Недопустимый путь в манифесте: {}", entry.path))?;
        let rel_key = rel.to_string_lossy().replace('\\', "/");

        // Включён ли мод. Обязательные файлы (ядро, конфиги) — всегда «включены».
        let enabled = if entry.optional {
            choices
                .get(&mod_choice_key(entry))
                .copied()
                .unwrap_or(entry.enabled_by_default)
        } else {
            true
        };

        // Активное имя файла — то, под которым он должен лежать сейчас;
        // неактивное — противоположный вариант (его убираем, чтобы не было
        // дубликата мода на диске).
        let normal = game_dir.join(&rel);
        let disabled = disabled_variant(&normal);
        let (active, inactive) = if enabled {
            (normal, disabled)
        } else {
            (disabled, normal)
        };
        let active_key = if enabled {
            rel_key.clone()
        } else {
            format!("{rel_key}{DISABLED_SUFFIX}")
        };

        let matches = |path: &Path| {
            file_sha1(path)
                .map(|h| h.eq_ignore_ascii_case(&entry.sha1))
                .unwrap_or(false)
        };

        // 1. Уже актуален под нужным именем — ничего не делаем, чистим дубль.
        if matches(&active) {
            remove_if_exists(&inactive);
            desired.insert(active_key, entry.sha1.clone());
            progress.item_done(format!("Сборка {}: {rel_key}", manifest.version));
            continue;
        }

        // 2. Обязательный конфиг с overwrite=false, который мы ставили ранее, —
        //    уважаем правки игрока, не трогаем.
        if !entry.optional
            && active.exists()
            && !entry.overwrite
            && state.files.contains_key(&active_key)
        {
            desired.insert(active_key, entry.sha1.clone());
            progress.item_done(format!("Сборка {}: {rel_key}", manifest.version));
            continue;
        }

        // 3. Нужное содержимое уже лежит под другим именем (мод просто
        //    переключили вкл/выкл) — переименовываем, без перекачки.
        if matches(&inactive) {
            remove_if_exists(&active);
            if let Some(parent) = active.parent() {
                let _ = std::fs::create_dir_all(parent);
            }
            std::fs::rename(&inactive, &active)
                .map_err(|e| format!("Не удалось переименовать {rel_key}: {e}"))?;
            desired.insert(active_key, entry.sha1.clone());
            progress.item_done(format!("Сборка {}: {rel_key}", manifest.version));
            continue;
        }

        // 4. Нужно качать — откладываем в параллельную очередь.
        let label = entry
            .display_name
            .clone()
            .unwrap_or_else(|| rel_key.clone());
        jobs.push(DownloadJob {
            url: entry.url.clone(),
            active,
            inactive,
            active_key,
            sha1: entry.sha1.clone(),
            rel_key,
            label,
        });
    }

    // Параллельно качаем то, чего нет на диске. Каждая загрузка проверяет SHA-1
    // и убирает неактивный дубль; первая ошибка прекращает обработку. Результаты
    // (active_key -> sha1) собираем, чтобы дописать в реестр после завершения.
    let version = manifest.version.clone();
    let mut stream = stream::iter(jobs.into_iter().map(|job| {
        let http = http.clone();
        let version = version.clone();
        async move {
            download_to_counted(progress, &http, &job.url, &job.active, &job.label).await?;
            match file_sha1(&job.active) {
                Some(got) if got.eq_ignore_ascii_case(&job.sha1) => {}
                Some(got) => {
                    return Err(format!(
                        "Контрольная сумма {} не совпала (ожидалась {}, получена {got})",
                        job.rel_key, job.sha1
                    ));
                }
                None => {
                    return Err(format!(
                        "Не удалось прочитать скачанный файл {}",
                        job.rel_key
                    ))
                }
            }
            remove_if_exists(&job.inactive);
            progress.item_done(format!("Сборка {version}: {}", job.rel_key));
            Ok((job.active_key, job.sha1))
        }
    }))
    .buffer_unordered(concurrency.max(1));

    while let Some(res) = stream.next().await {
        let (active_key, sha1) = res?;
        desired.insert(active_key, sha1);
    }

    // Убираем файлы, которые лаунчер ставил раньше, но в новой сборке их больше
    // нет. Удаляем только если игрок файл сам не менял.
    cleanup_stale(game_dir, &state, &desired);

    state.files = desired;
    write_state(game_dir, &state);

    Ok(())
}

/// Список опциональных клиентских модов активной сборки с текущим состоянием
/// (вкл/выкл) для экрана управления. Если активной сборки нет — пустой список.
pub async fn list_optional_mods(
    http: &reqwest::Client,
    data_dir: &Path,
    game_dir: &Path,
) -> Result<Vec<OptionalMod>, String> {
    let Some(manifest) = crate::backend::fetch_manifest(http).await? else {
        return Ok(Vec::new());
    };
    let choices = read_choices(data_dir);

    let mods = manifest
        .optional_client_mods()
        .map(|entry| {
            // Стабильный ключ: `mod_id`, а если его нет — путь файла. Так моды,
            // помеченные опциональными без явного modId, всё равно попадают в список.
            let mod_id = mod_choice_key(entry);
            let enabled = choices
                .get(&mod_id)
                .copied()
                .unwrap_or(entry.enabled_by_default);
            // Имя/описание: приоритет у манифеста. Если их там нет — пробуем
            // достать из метаданных самого jar (он всегда скачан, пусть и как
            // `.dis`). В последнюю очередь — имя файла.
            let jar_meta = if entry.display_name.is_none() || entry.description.is_none() {
                read_jar_mod_meta(game_dir, &entry.path)
            } else {
                None
            };
            let name = entry
                .display_name
                .clone()
                .or_else(|| jar_meta.as_ref().and_then(|m| m.name.clone()))
                .unwrap_or_else(|| file_name_of(&entry.path));
            let description = entry
                .description
                .clone()
                .or_else(|| jar_meta.as_ref().and_then(|m| m.description.clone()));
            OptionalMod {
                mod_id,
                name,
                description,
                enabled,
                size: entry.size,
            }
        })
        .collect();
    Ok(mods)
}

/// Включает/выключает опциональный мод. Сохраняет выбор и, если файл уже
/// скачан, мгновенно переименовывает его (± `.dis`) без обращения к серверу.
/// Если файл ещё не установлен, выбор применится при ближайшей синхронизации.
pub async fn set_mod_enabled(
    http: &reqwest::Client,
    data_dir: &Path,
    game_dir: &Path,
    mod_id: String,
    enabled: bool,
) -> Result<(), String> {
    // Выбор сохраняем всегда — даже если сервер недоступен.
    let mut choices = read_choices(data_dir);
    choices.insert(mod_id.clone(), enabled);
    write_choices(data_dir, &choices);

    // Пытаемся применить переименование сразу. Путь берём из манифеста (не
    // доверяем фронту). Если манифест недоступен — переименование произойдёт
    // при следующем запуске в sync().
    if let Ok(Some(manifest)) = crate::backend::fetch_manifest(http).await {
        let entry = manifest
            .optional_client_mods()
            .find(|m| mod_choice_key(m) == mod_id);
        if let Some(entry) = entry {
            if let Some(rel) = sanitize_rel_path(&entry.path) {
                apply_enabled_state(game_dir, &rel, enabled);
            }
        }
    }
    Ok(())
}

/// Переименовывает файл мода под текущее состояние, если он уже скачан.
fn apply_enabled_state(game_dir: &Path, rel: &Path, enabled: bool) {
    let normal = game_dir.join(rel);
    let disabled = disabled_variant(&normal);
    if enabled {
        // Делаем активным: `name.jar.dis` -> `name.jar`.
        if !normal.exists() && disabled.exists() {
            let _ = std::fs::rename(&disabled, &normal);
        }
    } else {
        // Выключаем: `name.jar` -> `name.jar.dis`.
        if normal.exists() {
            remove_if_exists(&disabled);
            let _ = std::fs::rename(&normal, &disabled);
        }
    }
}

/// Удаляет ранее установленные лаунчером файлы, отсутствующие в `desired`,
/// если их текущий SHA-1 совпадает с записанным (игрок не менял).
fn cleanup_stale(game_dir: &Path, state: &ManagedState, desired: &BTreeMap<String, String>) {
    for (rel_key, recorded_sha1) in &state.files {
        if desired.contains_key(rel_key) {
            continue;
        }
        // Ключ может нести суффикс `.dis` — разбираем обратно в путь.
        let (base, dis) = match rel_key.strip_suffix(DISABLED_SUFFIX) {
            Some(base) => (base, true),
            None => (rel_key.as_str(), false),
        };
        let Some(rel) = sanitize_rel_path(base) else {
            continue;
        };
        let mut path = game_dir.join(&rel);
        if dis {
            path = disabled_variant(&path);
        }
        let unchanged = file_sha1(&path)
            .map(|h| h.eq_ignore_ascii_case(recorded_sha1))
            .unwrap_or(false);
        if unchanged {
            let _ = std::fs::remove_file(&path);
            remove_empty_parents(game_dir, &path);
        }
    }
}

/// Путь выключенного варианта: к исходному имени дописывается `.dis`.
fn disabled_variant(p: &Path) -> PathBuf {
    let mut name: OsString = p.as_os_str().to_owned();
    name.push(DISABLED_SUFFIX);
    PathBuf::from(name)
}

fn remove_if_exists(path: &Path) {
    if path.exists() {
        let _ = std::fs::remove_file(path);
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

/// Имя файла из пути манифеста (для подписи мода, если нет display_name).
fn file_name_of(raw: &str) -> String {
    raw.replace('\\', "/")
        .rsplit('/')
        .next()
        .unwrap_or(raw)
        .to_string()
}

/// Имя и описание мода, вытащенные из метаданных jar.
#[derive(Debug, Default)]
struct JarModMeta {
    name: Option<String>,
    description: Option<String>,
}

/// Читает `displayName`/`description` первого мода из метаданных jar в game-dir.
///
/// Используется как запасной источник, когда в манифесте нет человекочитаемого
/// имени. Файл всегда присутствует на диске (выключенные моды лежат с суффиксом
/// `.dis`), поэтому проверяем оба варианта пути. NeoForge хранит метаданные в
/// `META-INF/neoforge.mods.toml` (новые версии) или `META-INF/mods.toml`
/// (legacy). Любая ошибка чтения/парсинга тихо даёт `None` — это лишь подсказка
/// для UI, она не должна ронять список модов.
fn read_jar_mod_meta(game_dir: &Path, manifest_path: &str) -> Option<JarModMeta> {
    let rel = sanitize_rel_path(manifest_path)?;
    let normal = game_dir.join(&rel);
    let jar_path = if normal.exists() {
        normal
    } else {
        let disabled = disabled_variant(&normal);
        if disabled.exists() {
            disabled
        } else {
            return None;
        }
    };

    let file = std::fs::File::open(&jar_path).ok()?;
    let mut zip = zip::ZipArchive::new(file).ok()?;

    let raw = ["META-INF/neoforge.mods.toml", "META-INF/mods.toml"]
        .iter()
        .find_map(|name| {
            use std::io::Read;
            let mut entry = zip.by_name(name).ok()?;
            let mut buf = String::new();
            entry.read_to_string(&mut buf).ok()?;
            Some(buf)
        })?;

    parse_mods_toml(&raw)
}

/// Достаёт имя/описание первого `[[mods]]` из текста `*.mods.toml`.
///
/// В файле часто встречаются плейсхолдеры вида `${file.jarVersion}` — их не
/// трогаем, для имени/описания они роли не играют. Описание в TOML обычно
/// многострочное (`'''…'''`), что `toml` парсит штатно.
fn parse_mods_toml(raw: &str) -> Option<JarModMeta> {
    let value: toml::Value = toml::from_str(raw).ok()?;
    let first = value.get("mods")?.as_array()?.first()?;
    let take = |key: &str| {
        first
            .get(key)
            .and_then(|v| v.as_str())
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
    };
    let meta = JarModMeta {
        name: take("displayName"),
        description: take("description"),
    };
    if meta.name.is_none() && meta.description.is_none() {
        None
    } else {
        Some(meta)
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

fn choices_path(data_dir: &Path) -> PathBuf {
    data_dir.join(CHOICES_FILE)
}

/// Выбор игрока по опциональным модам: `mod_id` -> включён ли.
fn read_choices(data_dir: &Path) -> BTreeMap<String, bool> {
    std::fs::read_to_string(choices_path(data_dir))
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn write_choices(data_dir: &Path, choices: &BTreeMap<String, bool>) {
    if let Ok(json) = serde_json::to_string_pretty(choices) {
        let _ = std::fs::write(choices_path(data_dir), json);
    }
}
