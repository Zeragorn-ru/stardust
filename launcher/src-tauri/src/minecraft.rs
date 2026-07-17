//! Минимальный запуск Minecraft-клиента из лаунчера.
//!
//! Это первая рабочая итерация: vanilla-клиент скачивается в папку данных
//! лаунчера, затем запускается с нашим ником, UUID и accessToken. Следующим
//! шагом сюда добавятся Fabric/моды и authlib-injector/Yggdrasil.

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::Instant;

#[cfg(windows)]
use std::os::windows::process::CommandExt;

use futures_util::stream::{self, StreamExt};
use serde::Deserialize;
use serde_json::Value;
use tauri::AppHandle;

use protocol::PlayerProfile;

use crate::progress::{DownloadScope, Progress, Stage};

const DEFAULT_VERSION: &str = "1.21.1";
const DEFAULT_NEOFORGE_BRANCH: &str = "21.1.";
const NEOFORGE_METADATA_URL: &str =
    "https://maven.neoforged.net/releases/net/neoforged/neoforge/maven-metadata.xml";
const VERSION_MANIFEST_URL: &str =
    "https://piston-meta.mojang.com/mc/game/version_manifest_v2.json";
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;

pub struct LaunchOptions {
    pub data_dir: PathBuf,
    pub settings_memory_mb: u32,
    pub download_concurrency: usize,
    pub java_provider: crate::java::JavaProvider,
    pub java_custom_path: Option<String>,
    pub profile: PlayerProfile,
    pub access_token: String,
}

pub async fn launch(
    app: AppHandle,
    http: &reqwest::Client,
    options: LaunchOptions,
) -> Result<Child, String> {
    let LaunchOptions {
        data_dir,
        settings_memory_mb,
        download_concurrency,
        java_provider,
        java_custom_path,
        profile,
        access_token,
    } = options;

    if let Err(cheat_name) = crate::game_guard::scan_for_cheats() {
        return Err(format!(
            "Обнаружена запрещённая программа: {cheat_name}. Закройте её перед запуском игры."
        ));
    }

    let root = data_dir.join("minecraft");
    let version_id =
        std::env::var("LAUNCHER_MC_VERSION").unwrap_or_else(|_| DEFAULT_VERSION.into());
    fs::create_dir_all(&root).map_err(|e| format!("Не удалось создать папку Minecraft: {e}"))?;

    // Минимум один поток; верхнюю границу ограничиваем, чтобы не открыть
    // слишком много соединений к серверам Mojang.
    let concurrency = download_concurrency.clamp(1, 16);

    let progress = Progress::new(app.clone());
    let java = crate::java::resolve_java(
        java_provider,
        java_custom_path.as_deref(),
        &progress,
        http,
        &data_dir,
    )
    .await?;

    let version = ensure_version(&progress, http, &root, &version_id).await?;
    ensure_client(&progress, http, &root, &version).await?;
    ensure_libraries(&progress, http, &root, &version, concurrency).await?;
    ensure_assets(&progress, http, &root, &version, concurrency).await?;
    let manifest = crate::backend::fetch_manifest(http, &data_dir).await?;
    let pinned_neoforge = manifest.as_ref().and_then(|m| {
        use protocol::LoaderKind;
        if m.loader.kind == LoaderKind::NeoForge && !m.loader.version.is_empty() {
            Some(m.loader.version.clone())
        } else {
            None
        }
    });
    let neoforge_id =
        ensure_neoforge(&progress, http, &root, &java, pinned_neoforge.as_deref()).await?;
    let loader = load_modloader_profile(&root, &neoforge_id)?;
    if loader.inherits_from != version.id {
        return Err(format!(
            "NeoForge профиль наследуется от {}, а запускаем {} — версии не совпадают",
            loader.inherits_from, version.id
        ));
    }
    progress.begin(
        Stage::NeoForgeLibraries,
        "checking",
        "Скачиваем библиотеки NeoForge…",
    );
    download_libraries(&progress, http, &root, &loader.libraries, concurrency).await?;
    progress.begin(
        Stage::Natives,
        "extracting",
        "Распаковываем native-библиотеки…",
    );
    extract_natives(&root, &version, &loader.libraries)?;

    let game_dir = root.join("game");
    fs::create_dir_all(&game_dir).map_err(|e| format!("Не удалось создать папку игры: {e}"))?;

    // Синхронизируем активную сборку (моды/конфиги) в игровой каталог.
    // Если активной сборки нет — функция тихо вернётся, запустим без модпака.
    progress.begin(Stage::Modpack, "checking", "Проверяем сборку…");
    crate::modpack::sync(
        &progress,
        http,
        &data_dir,
        &game_dir,
        concurrency,
        manifest.as_ref(),
    )
    .await?;

    let classpath = build_modloader_classpath(&root, &version, &loader);
    let natives_dir = natives_dir(&root, &version.id);

    let memory = settings_memory_mb;
    let natives_path = natives_dir.to_string_lossy().to_string();
    let mut args = Vec::<String>::new();

    // На macOS GLFW/LWJGL требуют -XstartOnFirstThread среди первых JVM-флагов.
    if cfg!(target_os = "macos") {
        args.push("-XstartOnFirstThread".into());
    }

    // Vanilla ruled JVM args: natives paths, OS-specific flags и т.д.
    args.extend(vanilla_jvm_args(&version, &natives_path));

    // На macOS раннее окно NeoForge (fmlearlywindow) часто падает при старте GLFW.
    if cfg!(target_os = "macos") {
        args.push("-Dfml.earlyWindowControl=false".into());
    }

    // Фиксированный heap — без этого JVM стартует с крошечной кучей и
    // перестраивает её по мере роста, что на слабых системах вызывает
    // длинные GC-паузы. Xms держим меньше Xmx (до 512M), чтобы ОС не
    // резервировала весь лимит сразу.
    let xms = memory.min(512);
    args.push(format!("-Xms{xms}M"));
    args.push(format!("-Xmx{memory}M"));
    // G1GC — наилучший выбор для Minecraft: короткие паузы ценой
    // небольшого оверхеда. На Temurin JRE default GC зависит от
    // платформы и может быть Serial/Parallel с паузами >1 с.
    args.push("-XX:+UseG1GC".into());
    args.push("-XX:+ParallelRefProcEnabled".into());
    args.push("-XX:+DisableExplicitGC".into());
    args.push("-XX:MaxGCPauseMillis=200".into());

    // JVM-аргументы NeoForge (module-path, --add-opens и т.д.) с подстановкой
    // плейсхолдеров. Без них BootstrapLauncher не стартует.
    args.extend(modloader_jvm_args(&root, &version, &loader));

    // authlib-injector: перенаправляет аутентификацию и текстуры на наш
    // auth-сервер, чтобы в игре отображался кастомный скин. Javaagent должен
    // идти среди JVM-аргументов (до main-класса). Если инжектор недоступен —
    // не валим запуск целиком: одиночная игра останется рабочей.
    let auth_url = crate::backend::base_url();
    match ensure_authlib_injector(&progress, http, &data_dir).await {
        Ok(jar) => {
            args.push(format!("-javaagent:{}={}", jar.to_string_lossy(), auth_url));
            if let Some(meta) = prefetch_yggdrasil_meta(http, auth_url).await {
                args.push(format!("-Dauthlibinjector.yggdrasil.prefetched={meta}"));
            }
        }
        Err(e) => tracing::warn!("authlib-injector недоступен, запуск без кастомных скинов: {e}"),
    }

    args.push("-cp".into());
    args.push(classpath);
    args.push(loader.main_class.clone());
    // Сначала vanilla game-аргументы (--username, --uuid и т.д.), затем FML-аргументы.
    args.extend(game_args(
        &root,
        &game_dir,
        &version,
        &profile,
        &access_token,
    ));
    args.extend(modloader_game_args(&loader));

    progress.begin(Stage::Launch, "launching", "Запускаем Minecraft…");
    progress.set_stage_fraction(1.0);

    let mut command = Command::new(java);
    command.args(&args).current_dir(&game_dir);
    hide_console(&mut command);

    let child = command
        .spawn()
        .map_err(|e| format!("Не удалось запустить Java/Minecraft: {e}"))?;

    Ok(child)
}

#[cfg_attr(not(windows), allow(unused_variables))]
fn hide_console(command: &mut Command) {
    #[cfg(windows)]
    {
        command.creation_flags(CREATE_NO_WINDOW);
    }
}

async fn ensure_version(
    progress: &Progress,
    http: &reqwest::Client,
    root: &Path,
    version_id: &str,
) -> Result<VersionJson, String> {
    progress.begin(
        Stage::Version,
        "checking",
        "Проверяем Minecraft 1.21.1 + NeoForge…",
    );
    let version_dir = root.join("versions").join(version_id);
    let version_path = version_dir.join(format!("{version_id}.json"));
    fs::create_dir_all(&version_dir).map_err(|e| e.to_string())?;

    if !version_path.exists() {
        let resp = http_get_with_retry(http, VERSION_MANIFEST_URL, "манифест Minecraft", 5).await?;
        let manifest: VersionManifest = resp
            .json()
            .await
            .map_err(|e| format!("Некорректный манифест Minecraft: {e}"))?;

        let Some(entry) = manifest.versions.into_iter().find(|v| v.id == version_id) else {
            return Err(format!("Версия Minecraft {version_id} не найдена"));
        };
        download_to(
            progress,
            http,
            &entry.url,
            &version_path,
            "version json",
            None,
            None,
        )
        .await?;
    }
    progress.set_stage_fraction(1.0);

    let json = fs::read_to_string(&version_path)
        .map_err(|e| format!("Не удалось прочитать version json: {e}"))?;
    serde_json::from_str(&json).map_err(|e| format!("Некорректный version json: {e}"))
}

async fn ensure_client(
    progress: &Progress,
    http: &reqwest::Client,
    root: &Path,
    version: &VersionJson,
) -> Result<(), String> {
    progress.begin(Stage::Client, "downloading", "Скачиваем клиент Minecraft…");
    let path = client_jar(root, &version.id);
    let Some(client) = version.downloads.get("client") else {
        return Err("В version json нет client jar".into());
    };
    if !file_matches(&path, client.sha1.as_deref(), client.size)? {
        download_to(
            progress,
            http,
            &client.url,
            &path,
            "client jar",
            client.sha1.as_deref(),
            client.size,
        )
        .await?;
    }
    progress.set_stage_fraction(1.0);
    Ok(())
}

async fn ensure_libraries(
    progress: &Progress,
    http: &reqwest::Client,
    root: &Path,
    version: &VersionJson,
    concurrency: usize,
) -> Result<(), String> {
    progress.begin(
        Stage::VanillaLibraries,
        "downloading",
        "Скачиваем библиотеки Minecraft…",
    );
    download_libraries(progress, http, root, &version.libraries, concurrency).await
}

/// Скачивает произвольный список библиотек (vanilla или NeoForge),
/// учитывая OS-rules и native-классификаторы. Загрузки идут параллельно с
/// ограничением по числу одновременных соединений; прогресс этапа двигается по
/// числу завершённых файлов.
async fn download_libraries(
    progress: &Progress,
    http: &reqwest::Client,
    root: &Path,
    libraries: &[Library],
    concurrency: usize,
) -> Result<(), String> {
    let mut jobs: Vec<DownloadJob> = Vec::new();
    for lib in libraries
        .iter()
        .filter(|lib| rules_allow(&lib.rules, &LaunchFeatures::default()))
    {
        if let Some(artifact) = lib.downloads.artifact.as_ref() {
            let path = root.join("libraries").join(&artifact.path);
            if !artifact.url.is_empty()
                && !file_matches(&path, artifact.sha1.as_deref(), artifact.size)?
            {
                jobs.push(DownloadJob {
                    url: artifact.url.clone(),
                    path,
                    label: artifact.path.clone(),
                    expected_sha1: artifact.sha1.clone(),
                    expected_size: artifact.size,
                });
            }
        }
        if let Some(classifiers) = lib.downloads.classifiers.as_ref() {
            if let Some(native_key) = native_classifier(lib) {
                if let Some(artifact) = classifiers.get(&native_key) {
                    let path = root.join("libraries").join(&artifact.path);
                    if !artifact.url.is_empty()
                        && !file_matches(&path, artifact.sha1.as_deref(), artifact.size)?
                    {
                        jobs.push(DownloadJob {
                            url: artifact.url.clone(),
                            path,
                            label: artifact.path.clone(),
                            expected_sha1: artifact.sha1.clone(),
                            expected_size: artifact.size,
                        });
                    }
                }
            }
        }
    }

    download_jobs(progress, http, jobs, concurrency).await
}

async fn ensure_assets(
    progress: &Progress,
    http: &reqwest::Client,
    root: &Path,
    version: &VersionJson,
    concurrency: usize,
) -> Result<(), String> {
    progress.begin(Stage::Assets, "downloading", "Скачиваем ресурсы игры…");
    let indexes = root.join("assets").join("indexes");
    fs::create_dir_all(&indexes).map_err(|e| e.to_string())?;
    let index_path = indexes.join(format!("{}.json", version.asset_index.id));
    if !file_matches(
        &index_path,
        version.asset_index.sha1.as_deref(),
        version.asset_index.size,
    )? {
        download_to(
            progress,
            http,
            &version.asset_index.url,
            &index_path,
            "asset index",
            version.asset_index.sha1.as_deref(),
            version.asset_index.size,
        )
        .await?;
    }

    let json = fs::read_to_string(&index_path)
        .map_err(|e| format!("Не удалось прочитать asset index: {e}"))?;
    let index: AssetIndex =
        serde_json::from_str(&json).map_err(|e| format!("Некорректный asset index: {e}"))?;

    // Asset index'ы Minecraft часто содержат несколько объектов с одинаковым
    // content-hash (например пустые .mcmeta). Они дают одинаковый путь
    // назначения, поэтому дедупим по hash: иначе несколько джоб качают в один
    // и тот же *.download временный файл параллельно и затирают друг друга,
    // а второй rename падает → этап assets срывается на чистой установке.
    let mut seen: std::collections::HashSet<&str> = std::collections::HashSet::new();
    let mut jobs: Vec<DownloadJob> = Vec::new();
    for object in index.objects.values() {
        if !seen.insert(object.hash.as_str()) {
            continue;
        }
        let prefix = object.hash.get(0..2).ok_or("Некорректный hash asset")?;
        let path = root
            .join("assets")
            .join("objects")
            .join(prefix)
            .join(&object.hash);
        if !file_matches(&path, Some(&object.hash), object.size)? {
            let url = format!(
                "https://resources.download.minecraft.net/{prefix}/{}",
                object.hash
            );
            jobs.push(DownloadJob {
                url,
                path,
                label: "assets".to_string(),
                expected_sha1: Some(object.hash.clone()),
                expected_size: object.size,
            });
        }
    }

    download_jobs(progress, http, jobs, concurrency).await
}

struct DownloadJob {
    url: String,
    path: PathBuf,
    label: String,
    expected_sha1: Option<String>,
    expected_size: Option<u64>,
}

fn file_matches(
    path: &Path,
    expected_sha1: Option<&str>,
    expected_size: Option<u64>,
) -> Result<bool, String> {
    if !path.exists() {
        return Ok(false);
    }

    if let Some(expected) = expected_size {
        let actual = fs::metadata(path)
            .map_err(|e| format!("Не удалось проверить размер {}: {e}", path.display()))?
            .len();
        if actual != expected {
            tracing::warn!(
                "[integrity] размер {} не совпал: {actual} != {expected}, перекачиваем",
                path.display()
            );
            let _ = fs::remove_file(path);
            return Ok(false);
        }
    }

    if let Some(expected) = expected_sha1.filter(|s| !s.trim().is_empty()) {
        let actual = compute_sha1(path)?;
        if !actual.eq_ignore_ascii_case(expected) {
            tracing::warn!(
                "[integrity] SHA-1 {} не совпал: {actual} != {expected}, перекачиваем",
                path.display()
            );
            let _ = fs::remove_file(path);
            return Ok(false);
        }
    }

    Ok(true)
}

/// Параллельно скачивает набор файлов с ограничением по числу одновременных
/// загрузок. Каждый завершённый файл двигает долю текущего этапа; скачанные
/// байты копятся для расчёта общей скорости. Первая ошибка прекращает
/// обработку и пробрасывается наверх.
async fn download_jobs(
    progress: &Progress,
    http: &reqwest::Client,
    jobs: Vec<DownloadJob>,
    concurrency: usize,
) -> Result<(), String> {
    progress.set_total_items(jobs.len());
    if jobs.is_empty() {
        progress.set_stage_fraction(1.0);
        return Ok(());
    }

    let mut stream = stream::iter(jobs.into_iter().map(|job| {
        let http = http.clone();
        async move {
            let res = download_to_counted(
                progress,
                &http,
                &job.url,
                &job.path,
                &job.label,
                job.expected_sha1.as_deref(),
                job.expected_size,
            )
            .await;
            (job.label, res)
        }
    }))
    .buffer_unordered(concurrency);

    while let Some((label, res)) = stream.next().await {
        res?;
        progress.item_done(format!("Скачано: {label}"));
    }
    Ok(())
}

fn extract_natives(
    root: &Path,
    version: &VersionJson,
    loader_libraries: &[Library],
) -> Result<(), String> {
    let dir = natives_dir(root, &version.id);
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;

    let mut extracted = std::collections::HashSet::new();
    let launch_features = LaunchFeatures::default();
    let libraries = version
        .libraries
        .iter()
        .chain(loader_libraries.iter())
        .filter(|lib| rules_allow(&lib.rules, &launch_features));

    for lib in libraries {
        // Старый формат: natives: {osx: "natives-macos"} + classifiers.
        if let Some(classifier) = native_classifier(lib) {
            if let Some(classifiers) = lib.downloads.classifiers.as_ref() {
                if let Some(artifact) = classifiers.get(&classifier) {
                    let jar_path = root.join("libraries").join(&artifact.path);
                    if jar_path.exists() && extracted.insert(artifact.path.clone()) {
                        extract_zip(&jar_path, &dir)?;
                    }
                }
            }
        }

        // MC 1.21+: отдельные записи вида group:artifact:version:natives-macos.
        if let Some(artifact) = lib.downloads.artifact.as_ref() {
            if native_artifact_for_current_os(&artifact.path, lib.name.as_deref()) {
                let jar_path = root.join("libraries").join(&artifact.path);
                if jar_path.exists() && extracted.insert(artifact.path.clone()) {
                    extract_zip(&jar_path, &dir)?;
                }
            }
        }
    }
    Ok(())
}

fn extract_zip(zip_path: &Path, target: &Path) -> Result<(), String> {
    let file = fs::File::open(zip_path).map_err(|e| format!("Не удалось открыть natives: {e}"))?;
    let mut archive =
        zip::ZipArchive::new(file).map_err(|e| format!("Некорректный natives jar: {e}"))?;
    for i in 0..archive.len() {
        let mut file = archive.by_index(i).map_err(|e| e.to_string())?;
        let name = file.name().replace('\\', "/");
        if name.ends_with('/') || name.starts_with("META-INF/") {
            continue;
        }
        let Some(file_name) = Path::new(&name).file_name() else {
            continue;
        };
        let out = target.join(file_name);
        let mut out_file = fs::File::create(out).map_err(|e| e.to_string())?;
        std::io::copy(&mut file, &mut out_file).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Строит classpath для NeoForge: сначала библиотеки NeoForge, затем vanilla
/// (без дубликатов по group:artifact[:classifier] — NeoForge имеет приоритет,
/// т.к. часто поднимает версии asm/guava/и т.п.), и vanilla-клиентский jar.
///
/// Сами universal/patched jar’ы NeoForge на classpath не попадают: их грузит FML
/// из libraryDirectory по координатам (аргумент `--fml.neoForgeVersion`).
fn build_modloader_classpath(
    root: &Path,
    vanilla: &VersionJson,
    loader: &ModLoaderProfile,
) -> String {
    let mut paths = Vec::new();
    let mut seen = std::collections::HashSet::new();

    let launch_features = LaunchFeatures::default();
    for lib in loader
        .libraries
        .iter()
        .filter(|l| rules_allow(&l.rules, &launch_features))
    {
        if let Some(artifact) = lib.downloads.artifact.as_ref() {
            if let Some(key) = library_dedup_key(lib) {
                seen.insert(key);
            }
            paths.push(root.join("libraries").join(&artifact.path));
        }
    }
    for lib in active_libraries(vanilla) {
        if let Some(key) = library_dedup_key(lib) {
            if seen.contains(&key) {
                continue;
            }
        }
        if let Some(artifact) = lib.downloads.artifact.as_ref() {
            paths.push(root.join("libraries").join(&artifact.path));
        }
    }
    // vanilla-клиентский jar остаётся нужен (исключён из module-path через ignoreList).
    paths.push(client_jar(root, &vanilla.id));
    join_classpath(&paths)
}

/// Ключ дедупликации библиотеки вида `group:artifact[:classifier]`,
/// без версии — чтобы vanilla и NeoForge не давали две версии одного jar.
fn library_dedup_key(lib: &Library) -> Option<String> {
    let name = lib.name.as_ref()?;
    let parts: Vec<&str> = name.split(':').collect();
    if parts.len() < 2 {
        return None;
    }
    let group = parts[0];
    let artifact = parts[1];
    // classifier — четвёртый элемент (group:artifact:version:classifier).
    let classifier = parts.get(3).copied().unwrap_or("");
    Some(format!("{group}:{artifact}:{classifier}"))
}

fn join_classpath(paths: &[PathBuf]) -> String {
    let sep = if cfg!(windows) { ";" } else { ":" };
    paths
        .iter()
        .map(|p| p.to_string_lossy().to_string())
        .collect::<Vec<_>>()
        .join(sep)
}

fn game_args(
    root: &Path,
    game_dir: &Path,
    version: &VersionJson,
    profile: &PlayerProfile,
    access_token: &str,
) -> Vec<String> {
    let features = LaunchFeatures::default();
    let args = if let Some(arguments) = version.arguments.as_ref() {
        resolve_arguments(&arguments.game, &features)
    } else {
        version
            .minecraft_arguments
            .clone()
            .unwrap_or_else(|| legacy_default_args().join(" "))
            .split_whitespace()
            .map(|s| s.to_string())
            .collect::<Vec<_>>()
    };

    let replacements = game_arg_replacements(root, game_dir, version, profile, access_token);
    args.into_iter()
        .map(|arg| substitute_tokens(&arg, &replacements))
        .collect()
}

/// Плейсхолдеры vanilla game-аргументов. Неизвестные quickPlay/resolution
/// подставляем безопасными значениями — на случай если ruled-блок всё же
/// попал в командную строку.
fn game_arg_replacements(
    root: &Path,
    game_dir: &Path,
    version: &VersionJson,
    profile: &PlayerProfile,
    access_token: &str,
) -> HashMap<&'static str, String> {
    let assets_dir = root.join("assets");
    HashMap::from([
        ("${auth_player_name}", profile.name.clone()),
        ("${version_name}", version.id.clone()),
        ("${game_directory}", game_dir.to_string_lossy().to_string()),
        ("${assets_root}", assets_dir.to_string_lossy().to_string()),
        ("${assets_index_name}", version.asset_index.id.clone()),
        ("${auth_uuid}", profile.id.clone()),
        ("${auth_access_token}", access_token.to_string()),
        ("${user_type}", "msa".to_string()),
        ("${version_type}", version.version_type.clone()),
        ("${clientid}", String::new()),
        ("${auth_xuid}", String::new()),
        ("${resolution_width}", "1280".to_string()),
        ("${resolution_height}", "720".to_string()),
        ("${quickPlayPath}", String::new()),
        ("${quickPlaySingleplayer}", String::new()),
        ("${quickPlayMultiplayer}", String::new()),
        ("${quickPlayRealms}", String::new()),
    ])
}

/// Разворачивает vanilla JVM-аргументы с OS/feature rules и подставляет
/// плейсхолдеры natives directory и launcher metadata.
/// `-cp` / `${classpath}` из version json пропускаем — classpath задаём ниже.
fn vanilla_jvm_args(version: &VersionJson, natives_directory: &str) -> Vec<String> {
    let replacements = HashMap::from([
        ("${natives_directory}", natives_directory.to_string()),
        ("${launcher_name}", "StarDust".to_string()),
        ("${launcher_version}", env!("CARGO_PKG_VERSION").to_string()),
    ]);
    let features = LaunchFeatures::default();
    let args = version
        .arguments
        .as_ref()
        .map(|a| resolve_arguments(&a.jvm, &features))
        .unwrap_or_default();
    args.into_iter()
        .map(|arg| substitute_tokens(&arg, &replacements))
        .filter(|arg| arg != "-cp" && arg != "${classpath}")
        .collect()
}

/// Разворачивает список аргументов Minecraft (jvm/game) с учётом rules.
fn resolve_arguments(values: &[Value], features: &LaunchFeatures) -> Vec<String> {
    let mut out = Vec::new();
    for value in values {
        out.extend(resolve_argument(value, features));
    }
    out
}

fn resolve_argument(value: &Value, features: &LaunchFeatures) -> Vec<String> {
    match value {
        Value::String(s) => vec![s.clone()],
        Value::Object(obj) => {
            let rules = obj
                .get("rules")
                .and_then(|r| serde_json::from_value::<Vec<Rule>>(r.clone()).ok());
            if !rules_allow(&rules, features) {
                return Vec::new();
            }
            match obj.get("value") {
                Some(Value::String(s)) => vec![s.clone()],
                Some(Value::Array(arr)) => arr
                    .iter()
                    .filter_map(|v| v.as_str().map(|s| s.to_string()))
                    .collect(),
                _ => Vec::new(),
            }
        }
        _ => Vec::new(),
    }
}

/// Проверяет, что путь артефакта — native-библиотека для текущей ОС/архитектуры.
fn native_artifact_for_current_os(path: &str, name: Option<&str>) -> bool {
    let haystack = format!(
        "{} {}",
        path.to_ascii_lowercase(),
        name.unwrap_or("").to_ascii_lowercase()
    );
    if !haystack.contains("natives") {
        return false;
    }
    if cfg!(target_os = "macos") {
        if cfg!(target_arch = "aarch64") {
            haystack.contains("natives-macos-arm64")
        } else {
            haystack.contains("natives-macos") && !haystack.contains("arm64")
        }
    } else if cfg!(target_os = "windows") {
        if cfg!(target_arch = "aarch64") {
            haystack.contains("natives-windows-arm64")
        } else {
            haystack.contains("natives-windows") && !haystack.contains("arm64")
        }
    } else if cfg!(target_arch = "aarch64") {
        haystack.contains("natives-linux-arm64") || haystack.contains("natives-linux-aarch64")
    } else {
        haystack.contains("natives-linux")
            && !haystack.contains("arm64")
            && !haystack.contains("aarch64")
    }
}

/// JVM-аргументы NeoForge из его профиля с подстановкой плейсхолдеров.
/// Это критичная часть: тут задаётся module-path (`-p …`), `-DlibraryDirectory`,
/// `-DignoreList` и `--add-opens/--add-exports`, без которых BootstrapLauncher
/// не сможет собрать модульную систему FML.
fn modloader_jvm_args(
    root: &Path,
    vanilla: &VersionJson,
    loader: &ModLoaderProfile,
) -> Vec<String> {
    let Some(arguments) = loader.arguments.as_ref() else {
        return Vec::new();
    };
    let library_directory = root.join("libraries");
    let classpath_separator = if cfg!(windows) { ";" } else { ":" };
    // ${version_name} в `-DignoreList` указывает на vanilla-клиентский jar
    // (`<id>.jar`), который должен грузиться по classpath, а не как модуль.
    let replacements = HashMap::from([
        (
            "${library_directory}",
            library_directory.to_string_lossy().to_string(),
        ),
        ("${classpath_separator}", classpath_separator.to_string()),
        ("${version_name}", vanilla.id.clone()),
    ]);

    let features = LaunchFeatures::default();
    arguments
        .jvm
        .iter()
        .flat_map(|value| resolve_argument(value, &features))
        .map(|arg| substitute_tokens(&arg, &replacements))
        .collect()
}

/// FML-аргументы игры из профиля NeoForge (`--fml.neoForgeVersion`,
/// `--launchTarget forgeclient` и т.д.). Плейсхолдеров там нет.
fn modloader_game_args(loader: &ModLoaderProfile) -> Vec<String> {
    let Some(arguments) = loader.arguments.as_ref() else {
        return Vec::new();
    };
    let features = LaunchFeatures::default();
    arguments
        .game
        .iter()
        .flat_map(|value| resolve_argument(value, &features))
        .collect()
}

/// Заменяет все вхождения `${...}`-плейсхолдеров внутри строки.
fn substitute_tokens(input: &str, replacements: &HashMap<&str, String>) -> String {
    let mut result = input.to_string();
    for (token, value) in replacements {
        if result.contains(token) {
            result = result.replace(token, value);
        }
    }
    result
}

fn legacy_default_args() -> Vec<&'static str> {
    vec![
        "--username",
        "${auth_player_name}",
        "--version",
        "${version_name}",
        "--gameDir",
        "${game_directory}",
        "--assetsDir",
        "${assets_root}",
        "--assetIndex",
        "${assets_index_name}",
        "--uuid",
        "${auth_uuid}",
        "--accessToken",
        "${auth_access_token}",
        "--userType",
        "${user_type}",
        "--versionType",
        "${version_type}",
    ]
}

fn active_libraries(version: &VersionJson) -> impl Iterator<Item = &Library> {
    version
        .libraries
        .iter()
        .filter(|lib| rules_allow(&lib.rules, &LaunchFeatures::default()))
}

/// Feature-флаги запуска для ruled game/jvm аргументов Minecraft.
#[derive(Debug, Clone, Default)]
struct LaunchFeatures {
    is_demo_user: bool,
    has_custom_resolution: bool,
    has_quick_plays_support: bool,
    is_quick_play_singleplayer: bool,
    is_quick_play_multiplayer: bool,
    is_quick_play_realms: bool,
}

impl LaunchFeatures {
    fn feature(&self, name: &str) -> bool {
        match name {
            "is_demo_user" => self.is_demo_user,
            "has_custom_resolution" => self.has_custom_resolution,
            "has_quick_plays_support" => self.has_quick_plays_support,
            "is_quick_play_singleplayer" => self.is_quick_play_singleplayer,
            "is_quick_play_multiplayer" => self.is_quick_play_multiplayer,
            "is_quick_play_realms" => self.is_quick_play_realms,
            _ => false,
        }
    }
}

fn rules_allow(rules: &Option<Vec<Rule>>, features: &LaunchFeatures) -> bool {
    let Some(rules) = rules else { return true };
    let mut allowed = false;
    for rule in rules {
        if rule.matches(features) {
            allowed = rule.action == "allow";
        }
    }
    allowed
}

fn native_classifier(lib: &Library) -> Option<String> {
    let natives = lib.natives.as_ref()?;
    let key = if cfg!(target_os = "windows") {
        "windows"
    } else if cfg!(target_os = "macos") {
        "osx"
    } else {
        "linux"
    };
    natives
        .get(key)
        .map(|s| s.replace("${arch}", native_arch()))
}

fn native_arch() -> &'static str {
    if cfg!(target_pointer_width = "64") {
        "64"
    } else {
        "32"
    }
}

fn client_jar(root: &Path, version_id: &str) -> PathBuf {
    root.join("versions")
        .join(version_id)
        .join(format!("{version_id}.jar"))
}

fn natives_dir(root: &Path, version_id: &str) -> PathBuf {
    root.join("versions").join(version_id).join("natives")
}

/// Устанавливает NeoForge в нашу portable-папку и возвращает id установленного
/// профиля (например `neoforge-21.1.234`).
///
/// Мы запускаем штатный NeoForge installer, но передаём ему явный путь через
/// `--install-client <dir>`. Без этого флага installer по умолчанию лезет в
/// `%APPDATA%\.minecraft` и падает — именно это было исходной ошибкой.
/// Installer также требует наличия `launcher_profiles.json` в целевой папке.
///
/// Сам installer прогоняет все processors (binpatch, remap и т.д.) своим проверенным
/// кодом, поэтому нам не нужно повторять эту логику вручную.
async fn ensure_neoforge(
    progress: &Progress,
    http: &reqwest::Client,
    root: &Path,
    java: &Path,
    pinned_version: Option<&str>,
) -> Result<String, String> {
    progress.begin(Stage::NeoForgeInstall, "checking", "Проверяем NeoForge…");
    let neoforge_version = if let Some(v) = pinned_version {
        v.to_string()
    } else {
        match std::env::var("LAUNCHER_NEOFORGE_VERSION")
            .ok()
            .filter(|v| !v.trim().is_empty())
        {
            Some(v) => v,
            None => latest_neoforge_21_1(http).await?,
        }
    };
    let profile_id = format!("neoforge-{neoforge_version}");
    let installer_dir = root
        .join("installers")
        .join("neoforge")
        .join(&neoforge_version);
    let installer = installer_dir.join(format!("neoforge-{neoforge_version}-installer.jar"));

    // NeoForge installer создаёт отдельный профиль в versions/. Если профиль уже
    // есть — не гоняем installer каждый запуск.
    let marker = root
        .join("versions")
        .join(&profile_id)
        .join(format!("{profile_id}.json"));
    // Проверяем не только json-профиль, но и patched client jar — installer
    // создаёт его в самом конце. Если jar отсутствует, установка была неполной
    // (например, installer упал на DOWNLOAD_MOJMAPS) и нужно переустановить.
    let patched_client = root
        .join("libraries")
        .join("net/neoforged/neoforge")
        .join(&neoforge_version)
        .join(format!("neoforge-{neoforge_version}-client.jar"));
    if marker.exists() && patched_client.exists() {
        return Ok(profile_id);
    }
    // Если маркер есть, но patched client отсутствует — удаляем маркер,
    // чтобы installer запустился заново.
    if marker.exists() {
        let _ = fs::remove_file(&marker);
        tracing::warn!(
            "[neoforge] обнаружена неполная установка (нет patched client), переустанавливаем"
        );
    }

    // Installer отказывается работать без launcher_profiles.json в целевой папке.
    // Это файл официального лаунчера; нам достаточно пустой заготовки.
    let profiles_file = root.join("launcher_profiles.json");
    if !profiles_file.exists() {
        fs::write(
            &profiles_file,
            r#"{"profiles":{},"settings":{},"version":3}"#,
        )
        .map_err(|e| format!("Не удалось создать launcher_profiles.json: {e}"))?;
    }

    // Повтор при ошибке: перекачиваем installer и пробуем установить заново.
    const MAX_ATTEMPTS: u32 = 3;
    let mut last_err = String::new();

    for attempt in 1..=MAX_ATTEMPTS {
        if attempt > 1 {
            tracing::warn!(
                "[neoforge] повтор установки {attempt}/{MAX_ATTEMPTS}: удаляем installer и перекачиваем"
            );
            progress.set_label(
                "retrying",
                format!("Повтор NeoForge ({attempt}/{MAX_ATTEMPTS})…"),
            );
            // Удаляем битый installer, чтобы download_to перекачал.
            let _ = fs::remove_file(&installer);
            // Пауза перед повтором.
            let _ = tauri::async_runtime::spawn_blocking(|| {
                std::thread::sleep(std::time::Duration::from_secs(3));
            })
            .await;
        }

        // Скачиваем installer (если нет на диске).
        let url = format!(
            "https://maven.neoforged.net/releases/net/neoforged/neoforge/{0}/neoforge-{0}-installer.jar",
            neoforge_version
        );
        if let Err(e) = download_to(
            progress,
            http,
            &url,
            &installer,
            "NeoForge installer",
            None,
            None,
        )
        .await
        {
            last_err = e;
            tracing::warn!(
                "[neoforge] ошибка скачивания installer (попытка {attempt}): {last_err}"
            );
            continue;
        }

        progress.set_label(
            "extracting",
            format!("Устанавливаем NeoForge {neoforge_version}…"),
        );
        let java_clone = java.to_path_buf();
        let installer_clone = installer.clone();
        let root_clone = root.to_path_buf();
        let neoforge_version_clone = neoforge_version.clone();
        let status = tauri::async_runtime::spawn_blocking(move || {
            tracing::debug!(
                "[neoforge] запускаем installer {} -> {}",
                installer_clone.display(),
                root_clone.display()
            );
            let mut command = Command::new(&java_clone);
            command
                .arg("-jar")
                .arg(&installer_clone)
                .arg("--install-client")
                .arg(&root_clone)
                .current_dir(&root_clone)
                .stdout(Stdio::piped())
                .stderr(Stdio::piped());
            hide_console(&mut command);
            let output = command
                .output()
                .map_err(|e| format!("Не удалось запустить NeoForge installer: {e}"))?;
            if !output.stdout.is_empty() {
                tracing::debug!(
                    "[neoforge-{}] stdout: {}",
                    neoforge_version_clone,
                    String::from_utf8_lossy(&output.stdout).trim_end()
                );
            }
            if !output.stderr.is_empty() {
                tracing::debug!(
                    "[neoforge-{}] stderr: {}",
                    neoforge_version_clone,
                    String::from_utf8_lossy(&output.stderr).trim_end()
                );
            }
            tracing::debug!(
                "[neoforge] installer завершился со статусом {}",
                output.status
            );
            let combined = format!(
                "{}\n{}",
                String::from_utf8_lossy(&output.stdout),
                String::from_utf8_lossy(&output.stderr)
            );
            Ok((output.status, combined))
        })
        .await
        .map_err(|e| format!("Ошибка потока NeoForge installer: {e}"))?
        .map_err(|e: String| e)?;

        let (status, installer_output) = status;
        // Пробрасываем вывод installer'а в UI-лог построчно.
        for line in installer_output.lines().filter(|l| !l.trim().is_empty()) {
            progress.log(format!("[neoforge] {line}"));
        }
        if !status.success() {
            let tail: String = installer_output
                .lines()
                .filter(|l| !l.trim().is_empty())
                .rev()
                .take(5)
                .collect::<Vec<_>>()
                .into_iter()
                .rev()
                .collect::<Vec<_>>()
                .join("\n");
            last_err = if tail.is_empty() {
                format!("NeoForge installer завершился с ошибкой ({status})")
            } else {
                format!("NeoForge installer завершился с ошибкой ({status}):\n{tail}")
            };
            tracing::warn!("[neoforge] ошибка установки (попытка {attempt}): {last_err}");
            continue;
        }
        if !marker.exists() {
            last_err =
                "NeoForge installer отработал, но профиль не появился в versions/".to_string();
            tracing::warn!("[neoforge] маркер не появился (попытка {attempt}): {last_err}");
            continue;
        }

        return Ok(profile_id);
    }

    Err(last_err)
}

/// Читает установленный профиль NeoForge из versions/<id>/<id>.json.
fn load_modloader_profile(root: &Path, profile_id: &str) -> Result<ModLoaderProfile, String> {
    let path = root
        .join("versions")
        .join(profile_id)
        .join(format!("{profile_id}.json"));
    let json = fs::read_to_string(&path)
        .map_err(|e| format!("Не удалось прочитать профиль NeoForge: {e}"))?;
    serde_json::from_str(&json).map_err(|e| format!("Некорректный профиль NeoForge: {e}"))
}

async fn latest_neoforge_21_1(http: &reqwest::Client) -> Result<String, String> {
    let resp = http_get_with_retry(http, NEOFORGE_METADATA_URL, "метаданные NeoForge", 5).await?;
    let xml = resp.text().await.map_err(network_error)?;

    xml.split("<version>")
        .filter_map(|part| {
            part.split_once("</version>")
                .map(|(v, _)| v.trim().to_string())
        })
        .filter(|v| v.starts_with(DEFAULT_NEOFORGE_BRANCH))
        .last()
        .ok_or_else(|| "Не удалось найти NeoForge для Minecraft 1.21.1".to_string())
}

/// API с метаданными последней сборки authlib-injector (апстрим, fallback).
const AUTHLIB_INJECTOR_LATEST: &str = "https://authlib-injector.yushi.moe/artifact/latest.json";

/// Минимальная структура метаданных `latest.json` authlib-injector.
#[derive(Deserialize)]
struct InjectorMeta {
    download_url: String,
    #[serde(default)]
    checksums: Option<InjectorChecksums>,
}

#[derive(Deserialize)]
struct InjectorChecksums {
    #[serde(default)]
    sha256: Option<String>,
}

/// Скачивает (и кэширует) authlib-injector.jar в папку данных лаунчера.
///
/// Источник по умолчанию — наш admin-server (`/authlib-injector.jar`): он
/// проксирует и кэширует апстрим, поэтому клиенту не нужен прямой доступ к
/// `yushi.moe`. Если admin-server недоступен — падаем на апстрим напрямую
/// с обязательной проверкой SHA-256 хеша из `latest.json`.
async fn ensure_authlib_injector(
    progress: &Progress,
    http: &reqwest::Client,
    data_dir: &Path,
) -> Result<PathBuf, String> {
    let jar = data_dir.join("authlib-injector.jar");
    if jar.exists() {
        return Ok(jar);
    }
    progress.set_label("checking", "Загружаем authlib-injector…");

    // Путь 1: admin-server (наш сервер, доверяем ему).
    let admin_url = format!("{}/authlib-injector.jar", crate::backend::admin_base_url());
    if let Err(e) = download_to(
        progress,
        http,
        &admin_url,
        &jar,
        "authlib-injector",
        None,
        None,
    )
    .await
    {
        tracing::warn!("admin-server не отдал authlib-injector ({e}), пробую апстрим");
        // Путь 2: прямой апстрим с проверкой SHA-256 из latest.json.
        let meta = fetch_injector_meta(http).await?;
        download_to(
            progress,
            http,
            &meta.download_url,
            &jar,
            "authlib-injector",
            None,
            None,
        )
        .await?;
        // Верификация SHA-256 после скачивания.
        if let Some(expected) = &meta.sha256 {
            tauri::async_runtime::spawn_blocking({
                let jar = jar.clone();
                let expected = expected.trim().to_lowercase();
                move || -> Result<(), String> {
                    let actual = compute_sha256_file(&jar)?;
                    if actual != expected {
                        let _ = std::fs::remove_file(&jar);
                        return Err(format!(
                            "SHA-256 authlib-injector не совпал: получен {actual}, ожидался {expected}"
                        ));
                    }
                    Ok(())
                }
            })
            .await
            .map_err(|e| format!("Ошибка потока SHA-256: {e}"))??;
        }
    }
    Ok(jar)
}

/// Метаданные апстрима authlib-injector: URL скачивания и хеш.
struct InjectorMetaInfo {
    download_url: String,
    sha256: Option<String>,
}

/// Получает метаданные свежего authlib-injector из `latest.json` апстрима.
async fn fetch_injector_meta(http: &reqwest::Client) -> Result<InjectorMetaInfo, String> {
    let meta: InjectorMeta = http
        .get(AUTHLIB_INJECTOR_LATEST)
        .send()
        .await
        .map_err(network_error)?
        .error_for_status()
        .map_err(|e| format!("Не удалось получить метаданные authlib-injector: {e}"))?
        .json()
        .await
        .map_err(network_error)?;
    Ok(InjectorMetaInfo {
        download_url: meta.download_url,
        sha256: meta.checksums.and_then(|c| c.sha256),
    })
}

/// Вычисляет SHA-256 файла и возвращает hex-строку (lowercase).
fn compute_sha256_file(path: &Path) -> Result<String, String> {
    crate::sha256::compute_sha256_file(path)
}

/// Префетч метаданных Yggdrasil-API (base64), чтобы authlib-injector не ходил
/// за ними сам при старте игры. Ошибки не критичны — вернём `None`.
async fn prefetch_yggdrasil_meta(http: &reqwest::Client, auth_url: &str) -> Option<String> {
    use base64::Engine;
    let bytes = http
        .get(format!("{auth_url}/"))
        .send()
        .await
        .ok()?
        .error_for_status()
        .ok()?
        .bytes()
        .await
        .ok()?;
    Some(base64::engine::general_purpose::STANDARD.encode(&bytes))
}

/// Скачивает один файл, занимающий весь текущий этап: прогресс этапа двигается
/// по байтам, в UI идут скорость/ETA. Используется для крупных одиночных
/// загрузок (Java, клиент, installer, version json).
pub(crate) async fn download_to(
    progress: &Progress,
    http: &reqwest::Client,
    url: &str,
    path: &Path,
    label: &str,
    expected_sha1: Option<&str>,
    expected_size: Option<u64>,
) -> Result<(), String> {
    download_inner(
        progress,
        http,
        url,
        path,
        label,
        DownloadScope::Stage,
        expected_sha1,
        expected_size,
    )
    .await
}

/// Скачивает один файл многофайлового этапа: долей этапа управляет счётчик
/// файлов снаружи, здесь лишь копятся байты для общей скорости.
pub(crate) async fn download_to_counted(
    progress: &Progress,
    http: &reqwest::Client,
    url: &str,
    path: &Path,
    label: &str,
    expected_sha1: Option<&str>,
    expected_size: Option<u64>,
) -> Result<(), String> {
    download_inner(
        progress,
        http,
        url,
        path,
        label,
        DownloadScope::Item,
        expected_sha1,
        expected_size,
    )
    .await
}

#[allow(clippy::too_many_arguments)]
async fn download_inner(
    progress: &Progress,
    http: &reqwest::Client,
    url: &str,
    path: &Path,
    label: &str,
    scope: DownloadScope,
    expected_sha1: Option<&str>,
    expected_size: Option<u64>,
) -> Result<(), String> {
    use sha1::{Digest, Sha1};
    use std::io::{Read as _, Write};

    const MAX_ATTEMPTS: u32 = 5;
    /// Таймаут на один чанк: 30 секунд. Если за это время чанк не пришёл —
    /// считаем соединение повреждённым и пробуем заново (с resume).
    const CHUNK_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);

    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }

    let tmp = path.with_extension("download");
    let mut last_err = String::new();

    for attempt in 1..=MAX_ATTEMPTS {
        // ── Экспоненциальная задержка: 2 → 4 → 8 → 8 → 8 сек ──
        if attempt > 1 {
            let delay_secs = std::cmp::min(2u64.pow(attempt - 1), 8);
            tracing::debug!(
                "[download] повтор {attempt}/{MAX_ATTEMPTS} (ожидание {delay_secs}с): {url}"
            );
            let _ = tauri::async_runtime::spawn_blocking(move || {
                std::thread::sleep(std::time::Duration::from_secs(delay_secs));
            })
            .await;
        }

        // ── Определяем offset для resume ──
        let resume_from: u64 = if attempt > 1 {
            fs::metadata(&tmp).map(|m| m.len()).unwrap_or(0)
        } else {
            0
        };

        // ── HTTP-запрос (с Range-заголовком при resume) ──
        let mut req = http.get(url);
        if resume_from > 0 {
            req = req.header("Range", format!("bytes={resume_from}-"));
        }
        let resp = match req.send().await {
            Ok(r) => r,
            Err(e) => {
                last_err = format!("Сетевая ошибка при скачивании {label}: {e}");
                tracing::warn!("[download] ошибка (попытка {attempt}): {last_err}");
                continue;
            }
        };
        let mut resp = match resp.error_for_status() {
            Ok(r) => r,
            Err(e) => {
                last_err = format!("Не удалось скачать {label}: {e}");
                tracing::warn!("[download] HTTP ошибка (попытка {attempt}): {last_err}");
                continue;
            }
        };

        // ── Определяем offset для resume ──
        // 206 Partial Content — сервер принял Range, дописываем к существующему.
        // 200 OK (или любой другой) — полный ответ, начинаем с нуля,
        // даже если мы отправили Range (бывает сsome CDN/прокси).
        let is_partial = resp.status() == 206;
        let actual_offset = if is_partial && resume_from > 0 {
            resume_from
        } else {
            0
        };

        let total = resp.content_length().map(|cl| cl + actual_offset);
        let mut file = if actual_offset > 0 {
            // Resume: открываем существующий файл и дописываем
            match fs::OpenOptions::new().append(true).open(&tmp) {
                Ok(f) => f,
                Err(_) => {
                    // Файл пропал — начинаем с нуля
                    match fs::File::create(&tmp) {
                        Ok(f) => f,
                        Err(e) => {
                            return Err(format!(
                                "Не удалось создать временный файл {}: {e}",
                                tmp.display()
                            ))
                        }
                    }
                }
            }
        } else {
            match fs::File::create(&tmp) {
                Ok(f) => f,
                Err(e) => {
                    return Err(format!(
                        "Не удалось создать временный файл {}: {e}",
                        tmp.display()
                    ))
                }
            }
        };

        let mut downloaded = actual_offset;
        let mut hasher = Sha1::new();
        // Если resume — нужно учесть уже скачанные байты в хеше.
        if actual_offset > 0 {
            hasher = tauri::async_runtime::spawn_blocking({
                let tmp = tmp.clone();
                move || -> Result<Sha1, String> {
                    let mut f = fs::File::open(&tmp)
                        .map_err(|e| format!("Не удалось прочитать файл для хеша: {e}"))?;

                    let mut temp_hasher = Sha1::new();
                    let mut remaining = actual_offset;
                    let mut buf = vec![0u8; 64 * 1024]; // 64 KB chunk

                    while remaining > 0 {
                        let to_read = std::cmp::min(remaining, buf.len() as u64) as usize;
                        let slice = &mut buf[..to_read];
                        f.read_exact(slice).map_err(|e| {
                            format!("Не удалось прочитать файл для хеша (resume): {e}")
                        })?;
                        temp_hasher.update(slice);
                        remaining -= to_read as u64;
                    }
                    Ok(temp_hasher)
                }
            })
            .await
            .map_err(|e| format!("Ошибка потока: {e}"))??;
        }

        let started = Instant::now();
        if let DownloadScope::Stage = scope {
            progress.set_label("downloading", format!("Скачиваем {label}"));
            progress.download_tick(downloaded, total, started);
        }

        let mut chunk_err: Option<String> = None;
        loop {
            // Таймаут на чтение одного чанка — ловим «повисшее» соединение.
            match tokio::time::timeout(CHUNK_TIMEOUT, resp.chunk()).await {
                Ok(Ok(Some(chunk))) => {
                    hasher.update(&chunk);
                    if let Err(e) = file.write_all(&chunk) {
                        return Err(e.to_string());
                    }
                    downloaded += chunk.len() as u64;
                    match scope {
                        DownloadScope::Stage => progress.download_tick(downloaded, total, started),
                        DownloadScope::Item => progress.add_bytes(chunk.len() as u64),
                    }
                }
                Ok(Ok(None)) => break,
                Ok(Err(e)) => {
                    chunk_err = Some(format!("Обрыв при скачивании {label}: {e}"));
                    break;
                }
                Err(_elapsed) => {
                    chunk_err = Some(format!("Таймаут {label}: нет данных {CHUNK_TIMEOUT:?}"));
                    break;
                }
            }
        }

        if let Some(e) = chunk_err {
            last_err = e;
            tracing::warn!("[download] обрыв (попытка {attempt}): {last_err}");
            // НЕ удаляем tmp — при следующей попытке сделаем resume.
            continue;
        }

        if let Err(e) = file.flush() {
            return Err(e.to_string());
        }
        drop(file);

        // ── Верификация размера ──
        if let Some(expected) = expected_size {
            if downloaded != expected {
                last_err =
                    format!("Размер {label}: скачано {downloaded} байт, ожидалось {expected}");
                tracing::warn!("[download] неверный размер (попытка {attempt}): {last_err}");
                let _ = fs::remove_file(&tmp);
                continue;
            }
        }

        // ── Верификация SHA-1 (по хешу, собранному по ходу скачивания) ──
        if let Some(expected) = expected_sha1 {
            let actual = format!("{:x}", hasher.finalize());
            if !actual.eq_ignore_ascii_case(expected) {
                last_err = format!("SHA-1 {label}: получен {actual}, ожидался {expected}");
                tracing::warn!("[download] неверный хеш (попытка {attempt}): {last_err}");
                let _ = fs::remove_file(&tmp);
                continue;
            }
        }

        fs::rename(&tmp, path).map_err(|e| {
            format!(
                "Не удалось переместить {} в {}: {e}",
                tmp.display(),
                path.display()
            )
        })?;
        tracing::debug!("[download] OK ({downloaded} байт): {url}");
        return Ok(());
    }

    // Очистка temp-файла при финальном провале.
    let _ = fs::remove_file(&tmp);
    Err(last_err)
}

fn network_error(e: reqwest::Error) -> String {
    if e.is_connect() {
        format!("Не удалось подключиться: {e}")
    } else if e.is_timeout() {
        format!("Таймаут соединения: {e}")
    } else {
        format!("Сетевая ошибка: {e}")
    }
}

/// Выполняет HTTP-запрос с повторами. Используется для лёгких запросов
/// (манифест, метаданные), где нужен retry, но не нужен resume.
async fn http_get_with_retry(
    http: &reqwest::Client,
    url: &str,
    label: &str,
    max_attempts: u32,
) -> Result<reqwest::Response, String> {
    let mut last_err = String::new();
    for attempt in 1..=max_attempts {
        if attempt > 1 {
            let delay_secs = std::cmp::min(2u64.pow(attempt - 1), 8);
            tracing::debug!("[http] повтор {attempt}/{max_attempts} ({label})");
            let _ = tauri::async_runtime::spawn_blocking(move || {
                std::thread::sleep(std::time::Duration::from_secs(delay_secs));
            })
            .await;
        }
        match http.get(url).send().await {
            Ok(resp) => match resp.error_for_status() {
                Ok(r) => return Ok(r),
                Err(e) => {
                    last_err = format!("HTTP ошибка {label}: {e}");
                    tracing::warn!("[http] {last_err} (попытка {attempt})");
                }
            },
            Err(e) => {
                last_err = format!("Сетевая ошибка {label}: {e}");
                tracing::warn!("[http] {last_err} (попытка {attempt})");
            }
        }
    }
    Err(last_err)
}

fn compute_sha1(path: &Path) -> Result<String, String> {
    use sha1::{Digest, Sha1};
    let bytes = fs::read(path)
        .map_err(|e| format!("Не удалось прочитать файл для хеша {}: {e}", path.display()))?;
    let mut hasher = Sha1::new();
    hasher.update(&bytes);
    Ok(format!("{:x}", hasher.finalize()))
}

#[derive(Debug, Deserialize)]
struct VersionManifest {
    versions: Vec<VersionManifestEntry>,
}

#[derive(Debug, Deserialize)]
struct VersionManifestEntry {
    id: String,
    url: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct VersionJson {
    id: String,
    #[serde(rename = "type")]
    version_type: String,
    // Сейчас запуск идёт только через NeoForge (BootstrapLauncher), поэтому
    // vanilla main class напрямую не используется, но поле описывает формат JSON
    // и пригодится для vanilla-запуска.
    #[allow(dead_code)]
    main_class: String,
    asset_index: AssetIndexInfo,
    downloads: HashMap<String, DownloadInfo>,
    libraries: Vec<Library>,
    #[serde(default)]
    minecraft_arguments: Option<String>,
    #[serde(default)]
    arguments: Option<VersionArguments>,
}

/// Профиль модлоадера (NeoForge), который наследуется от vanilla-версии.
/// В отличие от [`VersionJson`], у него нет `downloads`/`assetIndex` — он
/// переопределяет только main class, аргументы и список библиотек.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ModLoaderProfile {
    #[allow(dead_code)]
    id: String,
    inherits_from: String,
    main_class: String,
    #[serde(default)]
    libraries: Vec<Library>,
    #[serde(default)]
    arguments: Option<VersionArguments>,
}

#[derive(Debug, Deserialize)]
struct VersionArguments {
    #[serde(default)]
    game: Vec<Value>,
    #[serde(default)]
    jvm: Vec<Value>,
}

#[derive(Debug, Deserialize)]
struct DownloadInfo {
    url: String,
    #[serde(default)]
    sha1: Option<String>,
    #[serde(default)]
    size: Option<u64>,
}

#[derive(Debug, Deserialize)]
struct AssetIndexInfo {
    id: String,
    url: String,
    #[serde(default)]
    sha1: Option<String>,
    #[serde(default)]
    size: Option<u64>,
}

#[derive(Debug, Deserialize)]
struct AssetIndex {
    objects: HashMap<String, AssetObject>,
}

#[derive(Debug, Deserialize)]
struct AssetObject {
    hash: String,
    #[serde(default)]
    size: Option<u64>,
}

#[derive(Debug, Deserialize)]
struct Library {
    #[serde(default)]
    name: Option<String>,
    downloads: LibraryDownloads,
    #[serde(default)]
    rules: Option<Vec<Rule>>,
    #[serde(default)]
    natives: Option<HashMap<String, String>>,
}

#[derive(Debug, Deserialize)]
struct LibraryDownloads {
    #[serde(default)]
    artifact: Option<LibraryArtifact>,
    #[serde(default)]
    classifiers: Option<HashMap<String, LibraryArtifact>>,
}

#[derive(Debug, Deserialize)]
struct LibraryArtifact {
    path: String,
    url: String,
    #[serde(default)]
    sha1: Option<String>,
    #[serde(default)]
    size: Option<u64>,
}

#[derive(Debug, Clone, Deserialize)]
struct Rule {
    action: String,
    #[serde(default)]
    os: Option<RuleOs>,
    #[serde(default)]
    features: Option<HashMap<String, bool>>,
}

impl Rule {
    fn matches(&self, launch: &LaunchFeatures) -> bool {
        if let Some(os) = self.os.as_ref() {
            if let Some(name) = os.name.as_ref() {
                if name != current_os_name() {
                    return false;
                }
            }
            if let Some(arch) = os.arch.as_ref() {
                if !arch_matches(arch) {
                    return false;
                }
            }
        }
        if let Some(features) = self.features.as_ref() {
            for (name, expected) in features {
                if launch.feature(name) != *expected {
                    return false;
                }
            }
        }
        true
    }
}

#[derive(Debug, Clone, Deserialize)]
struct RuleOs {
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    arch: Option<String>,
}

fn arch_matches(rule_arch: &str) -> bool {
    match rule_arch {
        "x86" => cfg!(any(target_arch = "x86", target_arch = "x86_64")),
        "x86_64" => cfg!(target_arch = "x86_64"),
        "aarch64" => cfg!(target_arch = "aarch64"),
        other => current_arch_name() == other,
    }
}

fn current_arch_name() -> &'static str {
    if cfg!(target_arch = "x86_64") {
        "x86_64"
    } else if cfg!(target_arch = "aarch64") {
        "aarch64"
    } else if cfg!(target_arch = "x86") {
        "x86"
    } else {
        "unknown"
    }
}

fn current_os_name() -> &'static str {
    if cfg!(target_os = "windows") {
        "windows"
    } else if cfg!(target_os = "macos") {
        "osx"
    } else {
        "linux"
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn substitute_tokens_basic() {
        let mut replacements: HashMap<&str, String> = HashMap::new();
        replacements.insert("${auth_player_name}", "Steve".to_string());
        replacements.insert("${version_name}", "1.21.1".to_string());
        let result = substitute_tokens(
            "--username ${auth_player_name} --version ${version_name}",
            &replacements,
        );
        assert_eq!(result, "--username Steve --version 1.21.1");
    }

    #[test]
    fn substitute_tokens_no_match() {
        let replacements: HashMap<&str, String> = HashMap::new();
        let result = substitute_tokens("--no-tokens-here", &replacements);
        assert_eq!(result, "--no-tokens-here");
    }

    #[test]
    fn rules_allow_none_rules() {
        let features = LaunchFeatures::default();
        assert!(rules_allow(&None, &features));
    }

    #[test]
    fn rules_allow_empty_rules() {
        let features = LaunchFeatures::default();
        assert!(!rules_allow(&Some(vec![]), &features));
    }

    #[test]
    fn rules_allow_demo_only_when_feature_set() {
        let rules: Vec<Rule> =
            serde_json::from_str(r#"[{"action":"allow","features":{"is_demo_user":true}}]"#)
                .unwrap();
        let features = LaunchFeatures::default();
        assert!(!rules_allow(&Some(rules.clone()), &features));
        let demo = LaunchFeatures {
            is_demo_user: true,
            ..LaunchFeatures::default()
        };
        assert!(rules_allow(&Some(rules), &demo));
    }

    #[test]
    fn compute_sha1_known_input() {
        let dir = std::env::temp_dir().join("stardust_test_sha1");
        let _ = std::fs::create_dir_all(&dir);
        let path = dir.join("hello.txt");
        std::fs::write(&path, b"hello world").unwrap();
        let hash = compute_sha1(&path).unwrap();
        // SHA-1 of "hello world" is well-known.
        assert_eq!(hash, "2aae6c35c94fcfb415dbe95f408b9ce91ee846ed");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn resolve_argument_osx_rule() {
        let value: Value = serde_json::from_str(
            r#"{"rules":[{"action":"allow","os":{"name":"osx"}}],"value":["-XstartOnFirstThread"]}"#,
        )
        .unwrap();
        let features = LaunchFeatures::default();
        let args = resolve_argument(&value, &features);
        if cfg!(target_os = "macos") {
            assert_eq!(args, vec!["-XstartOnFirstThread"]);
        } else {
            assert!(args.is_empty());
        }
    }

    #[test]
    fn resolve_argument_string_value() {
        let value = Value::String("-Dfoo=bar".into());
        let features = LaunchFeatures::default();
        assert_eq!(resolve_argument(&value, &features), vec!["-Dfoo=bar"]);
    }

    #[test]
    fn vanilla_jvm_args_substitutes_natives_directory() {
        let version: VersionJson = serde_json::from_str(
            r#"{
                "id":"1.21.1","type":"release","mainClass":"x",
                "assetIndex":{"id":"1.21","url":"http://x"},
                "downloads":{"client":{"url":"http://x"}},
                "libraries":[],
                "arguments":{"jvm":["-Djava.library.path=${natives_directory}"]}
            }"#,
        )
        .unwrap();
        let args = vanilla_jvm_args(&version, "/tmp/natives");
        assert!(args.contains(&"-Djava.library.path=/tmp/natives".to_string()));
    }

    #[test]
    fn native_artifact_for_current_os_detects_macos_jar() {
        let path = "org/lwjgl/lwjgl-glfw/3.3.3/lwjgl-glfw-3.3.3-natives-macos.jar";
        if cfg!(target_os = "macos") && !cfg!(target_arch = "aarch64") {
            assert!(native_artifact_for_current_os(path, None));
        }
        let arm_path = "org/lwjgl/lwjgl-glfw/3.3.3/lwjgl-glfw-3.3.3-natives-macos-arm64.jar";
        if cfg!(target_os = "macos") && cfg!(target_arch = "aarch64") {
            assert!(native_artifact_for_current_os(arm_path, None));
        }
        if cfg!(target_os = "macos") && !cfg!(target_arch = "aarch64") {
            assert!(!native_artifact_for_current_os(arm_path, None));
        }
    }

    /// Хвост `arguments.game` из официального 1.21.1 version json (без внешних скобок).
    const GAME_ARGS_1211_TAIL: &str = r#"
        {"rules":[{"action":"allow","features":{"is_demo_user":true}}],"value":"--demo"},
        {"rules":[{"action":"allow","features":{"has_custom_resolution":true}}],
         "value":["--width","${resolution_width}","--height","${resolution_height}"]},
        {"rules":[{"action":"allow","features":{"has_quick_plays_support":true}}],
         "value":["--quickPlayPath","${quickPlayPath}"]}
    "#;

    fn version_json_with_game_args(game_tail: &str) -> VersionJson {
        let tail = if game_tail.trim().is_empty() {
            String::new()
        } else {
            format!(",{game_tail}")
        };
        serde_json::from_str(&format!(
            r#"{{
                "id":"1.21.1","type":"release","mainClass":"net.minecraft.client.main.Main",
                "assetIndex":{{"id":"1.21","url":"http://x"}},
                "downloads":{{"client":{{"url":"http://x"}}}},
                "libraries":[],
                "arguments":{{"game":[
                    "--username","${{auth_player_name}}",
                    "--version","${{version_name}}"
                    {tail}
                ]}}
            }}"#
        ))
        .unwrap()
    }

    #[test]
    fn resolve_game_args_1211_excludes_feature_gated_on_normal_launch() {
        let version = version_json_with_game_args(GAME_ARGS_1211_TAIL);
        let features = LaunchFeatures::default();
        let args = resolve_arguments(&version.arguments.as_ref().unwrap().game, &features);
        assert!(!args.contains(&"--demo".to_string()));
        assert!(!args.contains(&"--width".to_string()));
        assert!(!args.contains(&"${resolution_width}".to_string()));
        assert!(!args.contains(&"--quickPlayPath".to_string()));
    }

    #[test]
    fn resolve_game_args_1211_includes_demo_when_feature_set() {
        let version = version_json_with_game_args(GAME_ARGS_1211_TAIL);
        let features = LaunchFeatures {
            is_demo_user: true,
            ..LaunchFeatures::default()
        };
        let args = resolve_arguments(&version.arguments.as_ref().unwrap().game, &features);
        assert!(args.contains(&"--demo".to_string()));
    }

    #[test]
    fn game_args_substitutes_tokens_from_1211_fragment() {
        let version = version_json_with_game_args("");
        let root = std::env::temp_dir().join("stardust_test_game_args");
        let game_dir = root.join("game");
        let _ = std::fs::create_dir_all(&game_dir);
        let profile = PlayerProfile {
            id: "00000000000000000000000000000000".to_string(),
            name: "Steve".to_string(),
            active_badge: None,
            active_gradient: None,
            ban: None,
        };
        let args = game_args(&root, &game_dir, &version, &profile, "token123");
        assert!(args.contains(&"Steve".to_string()));
        assert!(args.contains(&"1.21.1".to_string()));
        assert!(!args.iter().any(|a| a.contains("${")));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn game_args_substitutes_resolution_defaults_when_forced_in() {
        let version = version_json_with_game_args(
            r#"{"rules":[{"action":"allow","features":{"has_custom_resolution":true}}],
               "value":["--width","${resolution_width}","--height","${resolution_height}"]}"#,
        );
        let mut features = LaunchFeatures::default();
        features.has_custom_resolution = true;
        let resolved = resolve_arguments(&version.arguments.as_ref().unwrap().game, &features);
        let root = std::env::temp_dir().join("stardust_test_resolution_args");
        let game_dir = root.join("game");
        let _ = std::fs::create_dir_all(&game_dir);
        let profile = PlayerProfile {
            id: "00000000000000000000000000000000".to_string(),
            name: "Steve".to_string(),
            active_badge: None,
            active_gradient: None,
            ban: None,
        };
        let replacements = game_arg_replacements(&root, &game_dir, &version, &profile, "token");
        let args: Vec<String> = resolved
            .into_iter()
            .map(|arg| substitute_tokens(&arg, &replacements))
            .collect();
        assert!(args.contains(&"1280".to_string()));
        assert!(args.contains(&"720".to_string()));
        let _ = std::fs::remove_dir_all(&root);
    }
}
