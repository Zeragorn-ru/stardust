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
// нет — берём `enabled_by_default` из манифеста, с поправкой на
// `PLATFORM_DEFAULT_DISABLED` (например Better Clouds на macOS).
//
// Профили модов взаимоисключающие: выбран ровно один, ключ хранится в
// `selected-profile.json` рядом с выборами модов (по умолчанию — первый
// профиль сборки). Мод с тегами профилей доступен (и переключается руками)
// только пока выбранный профиль входит в его теги; вне своего профиля он
// принудительно выключен. «Общие» моды без тегов от профилей не зависят.
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
    /// `modId` конфликтующих опциональных модов (манифест + статические правила).
    pub conflicts_with: Vec<String>,
    /// Профили, в которых состоит мод; пусто = «общий» (есть во всех).
    pub profiles: Vec<String>,
    /// Недоступен ли мод в текущем выбранном профиле: такой мод не
    /// переключается руками и принудительно выключен.
    pub locked: bool,
    /// Опциональный ли мод: у неопционального нет ручного тумблера,
    /// его состояние полностью определяет выбранный профиль.
    pub optional: bool,
}

/// Известные взаимоисключающие пары опциональных модов (modId ↔ modId).
/// Дополняют поле `conflictsWith` из манифеста.
const KNOWN_CONFLICTS: &[(&str, &str)] = &[
    // Distant Horizons и Voxy оба рисуют дальние чанки — вместе крашат/ломают LOD.
    ("distanthorizons", "voxy"),
];

/// Опциональные моды, которые на текущей платформе считаем выключенными по
/// умолчанию (если игрок ещё не сохранил явный выбор в `mod-choices.json`).
///
/// Явный `true` в выборе всё ещё включает мод — это подсказка платформы, а не
/// жёсткий запрет.
#[cfg(target_os = "macos")]
const PLATFORM_DEFAULT_DISABLED: &[&str] = &[];

#[cfg(not(target_os = "macos"))]
const PLATFORM_DEFAULT_DISABLED: &[&str] = &[];

fn normalize_mod_id(id: &str) -> String {
    id.trim().to_ascii_lowercase()
}

/// Включён ли опциональный мод с учётом выбора игрока, выбранного профиля
/// и platform-default.
///
/// Профильный гейт: у мода с тегами профилей выбранный профиль должен входить
/// в эти теги — иначе мод недоступен и принудительно выключен. Для «общих»
/// модов (без тегов) и при их совпадении дальше действует обычная логика:
/// выбор игрока → platform-default → enabled_by_default.
fn optional_mod_enabled(
    entry: &protocol::FileEntry,
    choices: &BTreeMap<String, bool>,
    selected_profile: Option<&str>,
) -> bool {
    if !profile_gate_open(entry, selected_profile) {
        return false;
    }
    let key = mod_choice_key(entry);
    if let Some(&choice) = choices.get(&key) {
        return choice;
    }
    let normalized = normalize_mod_id(&key);
    if PLATFORM_DEFAULT_DISABLED
        .iter()
        .any(|id| normalized == normalize_mod_id(id))
    {
        return false;
    }
    entry.enabled_by_default
}

/// Открыт ли мод в выбранном профиле: мод без тегов («общий») — да;
/// мод с тегами — да, только если выбранный профиль входит в его теги.
/// Неопциональные моды подчиняются гейту так же, как опциональные:
/// тег профиля означает «файл принадлежит этому профилю» независимо
/// от того, можно ли его переключать руками.
fn profile_gate_open(entry: &protocol::FileEntry, selected_profile: Option<&str>) -> bool {
    if entry.profiles.is_empty() {
        return true;
    }
    let Some(selected) = selected_profile else {
        // В сборке нет профилей, а у мода есть теги — считаем недоступным.
        return false;
    };
    entry
        .profiles
        .iter()
        .any(|k| k.eq_ignore_ascii_case(selected))
}

/// Итоговое состояние файла на диске: гейт по профилям накрывает и
/// опциональные, и обязательные моды с тегами; опциональность добавляет
/// лишь ручной тумблер поверх гейта.
fn file_enabled(
    entry: &protocol::FileEntry,
    choices: &BTreeMap<String, bool>,
    selected_profile: Option<&str>,
) -> bool {
    if !profile_gate_open(entry, selected_profile) {
        return false;
    }
    if !entry.optional {
        return true;
    }
    optional_mod_enabled(entry, choices, selected_profile)
}

/// Прочитать выбранный профиль из файла, сверив ключ с профилями манифеста.
/// Нет файла/неизвестный ключ → первый профиль манифеста (профили
/// взаимоисключающие, один всегда выбран). Манифест без профилей → `None`.
fn resolve_selected_profile(
    manifest: &protocol::Manifest,
    selected_profile_file: &Path,
) -> Option<String> {
    if manifest.mod_profiles.is_empty() {
        return None;
    }
    let saved = std::fs::read_to_string(selected_profile_file)
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    if let Some(key) = saved {
        if manifest
            .mod_profiles
            .iter()
            .any(|p| p.key.eq_ignore_ascii_case(&key))
        {
            return Some(key);
        }
    }
    manifest.mod_profiles.first().map(|p| p.key.clone())
}

/// Выбранный профиль с фоллбэком на первый профиль манифеста; записываем,
/// чтобы игрок видел выбранное, и UI не «прыгал» между перечитываниями.
fn read_selected_profile(
    manifest: &protocol::Manifest,
    selected_profile_file: &Path,
) -> Option<String> {
    let resolved = resolve_selected_profile(manifest, selected_profile_file);
    if let Some(key) = &resolved {
        write_selected_profile(selected_profile_file, key);
    }
    resolved
}

fn write_selected_profile(path: &Path, key: &str) {
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if let Err(e) = std::fs::write(path, key) {
        tracing::warn!("Не удалось сохранить выбранный профиль модов: {e}");
    }
}

/// Профиль опциональных модов, как его видит UI лаунчера.
#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ModProfileInfo {
    /// Стабильный ключ профиля.
    pub key: String,
    /// Человекочитаемое имя («Производительность»).
    pub name: String,
    /// Описание для UI.
    pub description: Option<String>,
    /// Выбран ли этот профиль (профили взаимоисключающие, выбран ровно один).
    pub selected: bool,
    /// Сколько опциональных модов входят в профиль.
    pub mod_count: usize,
}

/// Сводка профилей активной сборки: метаданные + выбранный профиль игрока.
/// Моды без профиля («общие») в подсчёты не входят.
pub async fn mod_profile_summary(
    http: &reqwest::Client,
    data_dir: &Path,
    selected_profile_file: &Path,
) -> Result<Vec<ModProfileInfo>, String> {
    let Some(manifest) = crate::backend::fetch_manifest(http, data_dir).await? else {
        return Ok(Vec::new());
    };
    let selected = read_selected_profile(&manifest, selected_profile_file);
    // Считаем все клиентские файлы с тегами: неопциональный мод из профиля
    // тоже входит в него (гейт в sync() действует на оба вида).
    let mods: Vec<_> = manifest.client_files().collect();

    Ok(manifest
        .mod_profiles
        .iter()
        .map(|p| {
            let members = mods
                .iter()
                .copied()
                .filter(|m| {
                    let keys = m.profiles.as_slice();
                    keys.iter().any(|k| k.eq_ignore_ascii_case(&p.key))
                })
                .count();
            ModProfileInfo {
                key: p.key.clone(),
                name: p.name.clone(),
                description: p.description.clone(),
                selected: selected
                    .as_deref()
                    .is_some_and(|s| s.eq_ignore_ascii_case(&p.key)),
                mod_count: members,
            }
        })
        .collect())
}

/// Выбирает профиль модов (профили взаимоисключающие). Сохраняет ключ в
/// `selected-profile.json` и применяет состояния на диск: моды, чьи теги не
/// включают новый профиль, выключаются гейтом, остальные возвращаются к
/// сохранённому выбору игрока (или дефолту). Переименование ± `.dis`, без
/// перекачки. Возвращает количество файлов, реально сменивших состояние.
pub async fn select_mod_profile(
    http: &reqwest::Client,
    data_dir: &Path,
    choices_file: &Path,
    selected_profile_file: &Path,
    game_dir: &Path,
    profile_key: &str,
) -> Result<usize, String> {
    let Some(manifest) = crate::backend::fetch_manifest(http, data_dir).await? else {
        return Err("Активная сборка недоступна".to_string());
    };
    let known = manifest
        .mod_profiles
        .iter()
        .any(|p| p.key.eq_ignore_ascii_case(profile_key));
    if !known {
        return Err(format!("Неизвестный профиль модов: {profile_key}"));
    }

    // Держим лок и на записи профиля, и на переименованиях: параллельный
    // set_mod_enabled не должен вклиниться между ними (см. CHOICES_LOCK).
    let choices = read_choices(data_dir, choices_file);
    let _guard = CHOICES_LOCK.lock().unwrap();
    write_selected_profile(selected_profile_file, profile_key);

    let mut applied = 0usize;
    // Все клиентские файлы (не только опциональные): тег профиля у
    // обязательного мода значит «файл принадлежит профилю» так же.
    for entry in manifest.client_files() {
        let enabled = file_enabled(entry, &choices, Some(profile_key));
        if let Some(rel) = sanitize_rel_path(&entry.path) {
            if apply_enabled_state(game_dir, &rel, enabled) {
                applied += 1;
            }
        }
    }
    Ok(applied)
}

/// Собирает список конфликтов для мода: манифест + симметричные статические правила.
fn conflicts_for(mod_id: &str, entry: &protocol::FileEntry) -> Vec<String> {
    let key = normalize_mod_id(mod_id);
    let mut out: Vec<String> = entry
        .conflicts_with
        .iter()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect();
    for &(a, b) in KNOWN_CONFLICTS {
        if key == a {
            out.push(b.to_string());
        } else if key == b {
            out.push(a.to_string());
        }
    }
    out.sort();
    out.dedup();
    out
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
#[allow(clippy::too_many_arguments)]
pub async fn sync(
    progress: &Progress,
    http: &reqwest::Client,
    data_dir: &Path,
    choices_file: &Path,
    selected_profile_file: &Path,
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

    let choices = read_choices(data_dir, choices_file);
    let selected_profile = read_selected_profile(manifest, selected_profile_file);
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
        size: u64,
        rel_key: String,
        label: String,
    }
    let mut jobs: Vec<DownloadJob> = Vec::new();

    for entry in entries.iter() {
        let rel = sanitize_rel_path(&entry.path)
            .ok_or_else(|| format!("Недопустимый путь в манифесте: {}", entry.path))?;
        let rel_key = rel.to_string_lossy().replace('\\', "/");

        // Включён ли файл: гейт по профилям действует и на обязательные
        // моды с тегами (неопциональный «в своём» профиле — включён,
        // в чужом — выключен), опциональность добавляет ручной тумблер.
        let enabled = file_enabled(entry, &choices, selected_profile.as_deref());

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

        let matches = |path: &Path| file_matches(path, &entry.sha1, entry.size).unwrap_or(false);

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
            size: entry.size,
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
            download_to_counted(
                progress,
                &http,
                &job.url,
                &job.active,
                &job.label,
                Some(&job.sha1),
                Some(job.size),
            )
            .await?;
            verify_file(&job.active, &job.rel_key, &job.sha1, job.size)?;
            remove_if_exists(&job.inactive);
            progress.item_done(format!("Сборка {version}: {}", job.rel_key));
            Ok::<_, String>((job.active_key, job.sha1))
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

/// Список клиентских модов активной сборки для экрана «Сборка»: опциональные
/// (с тумблером) и неопциональные с тегами профилей (управляются профилем).
/// Если активной сборки нет — пустой список.
pub async fn list_optional_mods(
    http: &reqwest::Client,
    data_dir: &Path,
    choices_file: &Path,
    selected_profile_file: &Path,
    game_dir: &Path,
) -> Result<Vec<OptionalMod>, String> {
    let Some(manifest) = crate::backend::fetch_manifest(http, data_dir).await? else {
        return Ok(Vec::new());
    };
    let choices = read_choices(data_dir, choices_file);
    let selected_profile = read_selected_profile(&manifest, selected_profile_file);

    let mods = manifest
        .client_files()
        // Обычные обязательные файлы (конфиги, ядро) не показываем;
        // обязательные моды с тегами профилей — показываем.
        .filter(|entry| entry.optional || !entry.profiles.is_empty())
        .map(|entry| {
            // Стабильный ключ: `mod_id`, а если его нет — путь файла. Так моды,
            // помеченные опциональными без явного modId, всё равно попадают в список.
            let mod_id = mod_choice_key(entry);
            let locked = !profile_gate_open(entry, selected_profile.as_deref());
            let enabled = file_enabled(entry, &choices, selected_profile.as_deref());
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
            let conflicts_with = conflicts_for(&mod_id, entry);
            OptionalMod {
                mod_id,
                name,
                description,
                enabled,
                size: entry.size,
                conflicts_with,
                profiles: entry.profiles.clone(),
                locked,
                optional: entry.optional,
            }
        })
        .collect();
    Ok(mods)
}

/// Сериализует чтение-модификацию-запись `mod-choices.json` и
/// `selected-profile.json`: set_mod_enabled и select_mod_profile —
/// async-команды, и без лока два быстрых переключения перетирали бы
/// друг друга (lost update).
static CHOICES_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// Включает/выключает опциональный мод. Сохраняет выбор и, если файл уже
/// скачан, мгновенно переименовывает его (± `.dis`) без обращения к серверу.
/// Если файл ещё не установлен, выбор применится при ближайшей синхронизации.
pub async fn set_mod_enabled(
    http: &reqwest::Client,
    data_dir: &Path,
    choices_file: &Path,
    selected_profile_file: &Path,
    game_dir: &Path,
    mod_id: String,
    enabled: bool,
) -> Result<(), String> {
    // Профильный гейт: мод, недоступный в выбранном профиле, руками не
    // переключается — сначала нужно выбрать профиль, которому он принадлежит.
    // Недоступный манифест не мешает сохранению выбора (см. комментарий ниже),
    // гейт тогда просто не проверяется — sync() выправит состояние при запуске.
    let manifest = crate::backend::fetch_manifest(http, data_dir)
        .await
        .ok()
        .flatten();
    if let Some(manifest) = &manifest {
        let selected = resolve_selected_profile(manifest, selected_profile_file);
        if let Some(entry) = manifest
            .optional_client_mods()
            .find(|m| mod_choice_key(m) == mod_id)
        {
            if !profile_gate_open(entry, selected.as_deref()) {
                return Err("Мод недоступен в выбранном профиле".to_string());
            }
        }
    }

    // Выбор сохраняем всегда — даже если сервер недоступен.
    {
        let _guard = CHOICES_LOCK.lock().unwrap();
        let mut choices = read_choices(data_dir, choices_file);
        choices.insert(mod_id.clone(), enabled);
        write_choices(choices_file, &choices);
    }

    // Пытаемся применить переименование сразу. Путь берём из манифеста (не
    // доверяем фронту). Если манифест недоступен — переименование произойдёт
    // при следующем запуске в sync().
    if let Some(manifest) = manifest {
        let selected = resolve_selected_profile(&manifest, selected_profile_file);
        if let Some(entry) = manifest
            .optional_client_mods()
            .find(|m| mod_choice_key(m) == mod_id)
        {
            let effective = enabled && profile_gate_open(entry, selected.as_deref());
            if let Some(rel) = sanitize_rel_path(&entry.path) {
                apply_enabled_state(game_dir, &rel, effective);
            }
        }
    }
    Ok(())
}

/// Переименовывает файл мода под текущее состояние, если он уже скачан.
/// Возвращает true, если состояние на диске реально изменилось.
fn apply_enabled_state(game_dir: &Path, rel: &Path, enabled: bool) -> bool {
    let normal = game_dir.join(rel);
    let disabled = disabled_variant(&normal);
    if enabled {
        // Делаем активным: `name.jar.dis` -> `name.jar`.
        if !normal.exists() && disabled.exists() {
            match std::fs::rename(&disabled, &normal) {
                Ok(()) => true,
                Err(e) => {
                    tracing::warn!("Не удалось включить {}: {e}", normal.display());
                    false
                }
            }
        } else {
            false
        }
    } else {
        // Выключаем: `name.jar` -> `name.jar.dis`.
        if normal.exists() {
            remove_if_exists(&disabled);
            match std::fs::rename(&normal, &disabled) {
                Ok(()) => true,
                Err(e) => {
                    tracing::warn!("Не удалось выключить {}: {e}", normal.display());
                    false
                }
            }
        } else {
            false
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

fn file_matches(path: &Path, expected_sha1: &str, expected_size: u64) -> Result<bool, String> {
    if !path.exists() {
        return Ok(false);
    }

    let actual_size = std::fs::metadata(path)
        .map_err(|e| format!("Не удалось проверить размер {}: {e}", path.display()))?
        .len();
    if actual_size != expected_size {
        tracing::warn!(
            "[modpack] размер {} не совпал: {actual_size} != {expected_size}, перекачиваем",
            path.display()
        );
        let _ = std::fs::remove_file(path);
        return Ok(false);
    }

    match file_sha1(path) {
        Some(actual) if actual.eq_ignore_ascii_case(expected_sha1) => Ok(true),
        Some(actual) => {
            tracing::warn!(
                "[modpack] SHA-1 {} не совпал: {actual} != {expected_sha1}, перекачиваем",
                path.display()
            );
            let _ = std::fs::remove_file(path);
            Ok(false)
        }
        None => {
            let _ = std::fs::remove_file(path);
            Ok(false)
        }
    }
}

fn verify_file(
    path: &Path,
    rel_key: &str,
    expected_sha1: &str,
    expected_size: u64,
) -> Result<(), String> {
    let actual_size = std::fs::metadata(path)
        .map_err(|e| format!("Не удалось проверить размер {rel_key}: {e}"))?
        .len();
    if actual_size != expected_size {
        let _ = std::fs::remove_file(path);
        return Err(format!(
            "Размер {rel_key} не совпал (ожидалось {expected_size}, получено {actual_size})"
        ));
    }

    match file_sha1(path) {
        Some(actual) if actual.eq_ignore_ascii_case(expected_sha1) => Ok(()),
        Some(actual) => {
            let _ = std::fs::remove_file(path);
            Err(format!(
                "Контрольная сумма {rel_key} не совпала (ожидалась {expected_sha1}, получена {actual})"
            ))
        }
        None => {
            let _ = std::fs::remove_file(path);
            Err(format!("Не удалось прочитать скачанный файл {rel_key}"))
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
    // Hex-кодирование без аллокаций: lookup table вместо format!().
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(40);
    for &b in &digest {
        out.push(HEX[(b >> 4) as usize] as char);
        out.push(HEX[(b & 0x0f) as usize] as char);
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
    match serde_json::to_string_pretty(state) {
        Ok(json) => {
            if let Err(e) = std::fs::write(state_path(game_dir), json) {
                tracing::warn!("Не удалось сохранить managed state: {e}");
            }
        }
        Err(e) => tracing::warn!("Не удалось сериализовать managed state: {e}"),
    }
}

/// Выбор игрока по опциональным модам: `mod_id` -> включён ли.
fn read_choices(data_dir: &Path, stable_file: &Path) -> BTreeMap<String, bool> {
    if let Ok(contents) = std::fs::read_to_string(stable_file) {
        return serde_json::from_str(&contents).unwrap_or_default();
    }

    let choices = std::fs::read_to_string(data_dir.join(CHOICES_FILE))
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default();
    write_choices(stable_file, &choices);
    choices
}

fn write_choices(path: &Path, choices: &BTreeMap<String, bool>) {
    match serde_json::to_string_pretty(choices) {
        Ok(json) => {
            if let Some(parent) = path.parent() {
                let _ = std::fs::create_dir_all(parent);
            }
            if let Err(e) = std::fs::write(path, json) {
                tracing::warn!("Не удалось сохранить выбор модов: {e}");
            }
        }
        Err(e) => tracing::warn!("Не удалось сериализовать выбор модов: {e}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mod_entry(mod_id: &str, profiles: &[&str], enabled_by_default: bool) -> protocol::FileEntry {
        protocol::FileEntry {
            path: format!("mods/{mod_id}.jar"),
            url: format!("https://example.com/{mod_id}.jar"),
            sha1: "0000000000000000000000000000000000000000".to_string(),
            size: 1,
            side: protocol::Side::Client,
            kind: protocol::FileKind::Mod,
            overwrite: true,
            optional: true,
            enabled_by_default,
            mod_id: Some(mod_id.to_string()),
            display_name: None,
            description: None,
            conflicts_with: Vec::new(),
            profiles: profiles.iter().map(|s| s.to_string()).collect(),
        }
    }

    fn manifest(profiles: &[(&str, &str)], mods: Vec<protocol::FileEntry>) -> protocol::Manifest {
        protocol::Manifest {
            name: "Test".to_string(),
            version: "1.0".to_string(),
            loader: protocol::LoaderInfo {
                minecraft: "1.21.1".to_string(),
                kind: protocol::LoaderKind::NeoForge,
                version: "21.1".to_string(),
            },
            files: mods,
            external_mod_policy: None,
            mod_profiles: profiles
                .iter()
                .map(|(key, name)| protocol::ModProfile {
                    key: key.to_string(),
                    name: name.to_string(),
                    description: None,
                })
                .collect(),
        }
    }

    #[test]
    fn gate_blocks_mods_from_other_profiles() {
        let perf = mod_entry("sodium", &["performance"], true);
        let quality = mod_entry("complementary", &["quality"], true);
        let common = mod_entry("fabric-api", &[], true);

        // Выбран performance: его моды доступны, чужие заблокированы.
        assert!(profile_gate_open(&perf, Some("performance")));
        assert!(!profile_gate_open(&quality, Some("performance")));
        assert!(profile_gate_open(&common, Some("performance")));

        // «Общий» мод открыт всегда, даже без выбранного профиля.
        assert!(profile_gate_open(&common, None));
        // Мод с тегами без выбранного профиля заблокирован.
        assert!(!profile_gate_open(&perf, None));
    }

    #[test]
    fn enabled_respects_gate_then_choices_then_default() {
        let perf = mod_entry("sodium", &["performance"], true);
        let mut choices = BTreeMap::new();

        // Гейт закрыт — выключен независимо от choices/default.
        assert!(!optional_mod_enabled(&perf, &choices, Some("quality")));

        // Гейт открыт: choices побеждают default.
        choices.insert("sodium".to_string(), false);
        assert!(!optional_mod_enabled(&perf, &choices, Some("performance")));
        choices.insert("sodium".to_string(), true);
        assert!(optional_mod_enabled(&perf, &choices, Some("performance")));

        // Нет choices — берём enabled_by_default.
        choices.clear();
        let off_by_default = mod_entry("voxy", &["performance"], false);
        assert!(optional_mod_enabled(&perf, &choices, Some("performance")));
        assert!(!optional_mod_enabled(&off_by_default, &choices, Some("performance")));
    }

    #[test]
    fn gate_covers_non_optional_tagged_files() {
        // Неопциональный мод с тегами: в чужом профиле выключен, в своём
        // включён (даже без choices — опциональность тут ни при чём).
        let required = protocol::FileEntry {
            optional: false,
            ..mod_entry("volcanic", &["perfomance"], true)
        };
        let choices = BTreeMap::new();

        assert!(!file_enabled(&required, &choices, Some("quality")));
        assert!(file_enabled(&required, &choices, Some("perfomance")));
        // Без профилей в сборке (selected=None) теговый файл недоступен.
        assert!(!file_enabled(&required, &choices, None));

        // Неопциональный без тегов («общий»): всегда включён.
        let common_required = protocol::FileEntry {
            optional: false,
            ..mod_entry("fabric-api", &[], true)
        };
        assert!(file_enabled(&common_required, &choices, None));
    }

    #[test]
    fn resolve_selected_profile_falls_back_to_first() {
        let m = manifest(
            &[("performance", "Производительность"), ("quality", "Качество")],
            vec![mod_entry("sodium", &["performance"], true)],
        );
        let dir = std::env::temp_dir().join("stardust_test_profiles");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();

        // Нет файла — первый профиль манифеста.
        let file = dir.join("selected-profile.json");
        assert_eq!(resolve_selected_profile(&m, &file).as_deref(), Some("performance"));

        // Неизвестный ключ — тоже первый профиль (не падаем).
        std::fs::write(&file, "deprecated-key").unwrap();
        assert_eq!(resolve_selected_profile(&m, &file).as_deref(), Some("performance"));

        // Валидный ключ используется как есть.
        std::fs::write(&file, "quality").unwrap();
        assert_eq!(resolve_selected_profile(&m, &file).as_deref(), Some("quality"));

        // Манифест без профилей — None.
        let no_profiles = manifest(&[], vec![mod_entry("sodium", &[], true)]);
        assert_eq!(resolve_selected_profile(&no_profiles, &file), None);

        let _ = std::fs::remove_dir_all(&dir);
    }
}
