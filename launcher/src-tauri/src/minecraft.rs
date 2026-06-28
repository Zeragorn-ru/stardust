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
const JAVA_VERSION: u32 = 21;
const TEMURIN_API_URL: &str =
    "https://api.adoptium.net/v3/binary/latest/21/ga/windows/x64/jre/hotspot/normal/eclipse";
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;

pub async fn launch(
    app: AppHandle,
    http: &reqwest::Client,
    data_dir: PathBuf,
    settings_memory_mb: u32,
    download_concurrency: usize,
    profile: PlayerProfile,
    access_token: String,
) -> Result<Child, String> {
    let root = data_dir.join("minecraft");
    let version_id =
        std::env::var("LAUNCHER_MC_VERSION").unwrap_or_else(|_| DEFAULT_VERSION.into());
    fs::create_dir_all(&root).map_err(|e| format!("Не удалось создать папку Minecraft: {e}"))?;

    // Минимум один поток; верхнюю границу ограничиваем, чтобы не открыть
    // слишком много соединений к серверам Mojang.
    let concurrency = download_concurrency.clamp(1, 16);

    let progress = Progress::new(app.clone());
    let java = ensure_java(&progress, http, &data_dir).await?;

    let version = ensure_version(&progress, http, &root, &version_id).await?;
    ensure_client(&progress, http, &root, &version).await?;
    ensure_libraries(&progress, http, &root, &version, concurrency).await?;
    ensure_assets(&progress, http, &root, &version, concurrency).await?;
    let manifest = crate::backend::fetch_manifest(http).await?;
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
    extract_natives(&root, &version)?;

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

    let mut args = Vec::<String>::new();
    args.push(format!("-Xmx{}M", settings_memory_mb));
    args.push(format!(
        "-Djava.library.path={}",
        natives_dir.to_string_lossy()
    ));
    // JVM-аргументы NeoForge (module-path, --add-opens и т.д.) с подстановкой
    // плейсхолдеров. Без них BootstrapLauncher не стартует.
    args.extend(modloader_jvm_args(&root, &version, &loader));

    // Прокси для сетевых соединений игры. Без этих аргументов Java-процесс
    // не знает о прокси и пытается ходить напрямую — если сеть блокирует
    // прямой выход, игра молча падает без окна.
    args.push("-Dhttp.proxyHost=assets.zeragorn.xyz".into());
    args.push("-Dhttp.proxyPort=3128".into());
    args.push("-Dhttps.proxyHost=assets.zeragorn.xyz".into());
    args.push("-Dhttps.proxyPort=3128".into());

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
        Err(e) => eprintln!("authlib-injector недоступен, запуск без кастомных скинов: {e}"),
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

async fn ensure_java(
    progress: &Progress,
    http: &reqwest::Client,
    data_dir: &Path,
) -> Result<PathBuf, String> {
    let runtime_dir = data_dir.join("runtime").join("java-21");
    if let Some(java) = bundled_java(&runtime_dir) {
        return Ok(java);
    }

    if !cfg!(windows) {
        if let Some(java) = system_java_21() {
            return Ok(java);
        }
        return Err("Автоскачивание Java пока реализовано только для Windows. Установи Java 21 или задай JAVA_HOME".into());
    }

    progress.begin(Stage::Java, "downloading", "Скачиваем приватную Java 21…");
    fs::create_dir_all(&runtime_dir)
        .map_err(|e| format!("Не удалось создать runtime Java: {e}"))?;
    let archive = data_dir.join("runtime").join("java-21.zip");
    download_to(progress, http, TEMURIN_API_URL, &archive, "Java 21 runtime", None, None).await?;
    progress.set_label("extracting", "Распаковываем Java 21…");
    extract_java_zip(&archive, &runtime_dir)?;
    let _ = fs::remove_file(&archive);

    bundled_java(&runtime_dir).ok_or_else(|| "Java 21 скачана, но javaw.exe не найден".to_string())
}

fn bundled_java(runtime_dir: &Path) -> Option<PathBuf> {
    let direct = runtime_dir
        .join("bin")
        .join(if cfg!(windows) { "javaw.exe" } else { "java" });
    if direct.exists() {
        return Some(direct);
    }
    for entry in fs::read_dir(runtime_dir).ok()? {
        let path = entry.ok()?.path();
        let java = path
            .join("bin")
            .join(if cfg!(windows) { "javaw.exe" } else { "java" });
        if java.exists() {
            return Some(java);
        }
    }
    None
}

fn system_java_21() -> Option<PathBuf> {
    if let Ok(home) = std::env::var("JAVA_HOME") {
        let exe = if cfg!(windows) { "javaw.exe" } else { "java" };
        let path = PathBuf::from(home).join("bin").join(exe);
        if path.exists() && java_is_21(&path) {
            return Some(path);
        }
    }
    let java = PathBuf::from(if cfg!(windows) { "javaw" } else { "java" });
    if java_is_21(&java) {
        Some(java)
    } else {
        None
    }
}

#[cfg_attr(not(windows), allow(unused_variables))]
fn hide_console(command: &mut Command) {
    #[cfg(windows)]
    {
        command.creation_flags(CREATE_NO_WINDOW);
    }
}

fn java_is_21(java: &Path) -> bool {
    let java_check = if cfg!(windows) {
        let mut p = java.to_path_buf();
        p.set_file_name("java.exe");
        p
    } else {
        java.to_path_buf()
    };
    let mut command = Command::new(java_check);
    command.arg("-version");
    hide_console(&mut command);
    let Ok(output) = command.output() else {
        return false;
    };
    let text = String::from_utf8_lossy(&output.stderr);
    parse_java_major(&text).is_some_and(|major| major >= JAVA_VERSION)
}

fn parse_java_major(text: &str) -> Option<u32> {
    let marker = "version \"";
    let start = text.find(marker)? + marker.len();
    let rest = &text[start..];
    let version = rest.split('"').next()?;
    let first = version.split('.').next()?;
    if first == "1" {
        version.split('.').nth(1)?.parse().ok()
    } else {
        first.parse().ok()
    }
}

fn extract_java_zip(archive: &Path, target: &Path) -> Result<(), String> {
    let file =
        fs::File::open(archive).map_err(|e| format!("Не удалось открыть Java archive: {e}"))?;
    let mut zip = zip::ZipArchive::new(file).map_err(|e| format!("Некорректный Java zip: {e}"))?;
    for i in 0..zip.len() {
        let mut file = zip.by_index(i).map_err(|e| e.to_string())?;
        let name = file.name().replace('\\', "/");
        if name.ends_with('/') {
            continue;
        }
        let stripped = name.split_once('/').map(|(_, rest)| rest).unwrap_or(&name);
        if stripped.is_empty() {
            continue;
        }
        // Защита от zip-slip: отвергаем любой путь, содержащий `..`-компоненты.
        // Это надёжнее canonicalize, который не работает для несуществующих файлов.
        if Path::new(stripped)
            .components()
            .any(|c| matches!(c, std::path::Component::ParentDir))
        {
            return Err(format!(
                "Небезопасный путь в zip: {name} (попытка выхода за пределы {})",
                target.display()
            ));
        }
        let out = target.join(stripped);
        if let Some(parent) = out.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let mut out_file = fs::File::create(&out).map_err(|e| e.to_string())?;
        std::io::copy(&mut file, &mut out_file).map_err(|e| e.to_string())?;
    }
    Ok(())
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
        let manifest: VersionManifest = http
            .get(VERSION_MANIFEST_URL)
            .send()
            .await
            .map_err(network_error)?
            .error_for_status()
            .map_err(|e| format!("Не удалось получить манифест Minecraft: {e}"))?
            .json()
            .await
            .map_err(|e| format!("Некорректный манифест Minecraft: {e}"))?;

        let Some(entry) = manifest.versions.into_iter().find(|v| v.id == version_id) else {
            return Err(format!("Версия Minecraft {version_id} не найдена"));
        };
        download_to(progress, http, &entry.url, &version_path, "version json", None, None).await?;
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
    if !path.exists() {
        let Some(client) = version.downloads.get("client") else {
            return Err("В version json нет client jar".into());
        };
        download_to(progress, http, &client.url, &path, "client jar", client.sha1.as_deref(), client.size).await?;
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
    for lib in libraries.iter().filter(|lib| rules_allow(&lib.rules)) {
        if let Some(artifact) = lib.downloads.artifact.as_ref() {
            let path = root.join("libraries").join(&artifact.path);
            if !path.exists() && !artifact.url.is_empty() {
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
                    if !path.exists() && !artifact.url.is_empty() {
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
    if !index_path.exists() {
        download_to(
            progress,
            http,
            &version.asset_index.url,
            &index_path,
            "asset index",
            None,
            None,
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
        if !path.exists() {
            let url = format!(
                "https://resources.download.minecraft.net/{prefix}/{}",
                object.hash
            );
            jobs.push(DownloadJob {
                url,
                path,
                label: "assets".to_string(),
                expected_sha1: Some(object.hash.clone()),
                expected_size: None,
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
            let res = download_to_counted(progress, &http, &job.url, &job.path, &job.label, job.expected_sha1.as_deref(), job.expected_size).await;
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

fn extract_natives(root: &Path, version: &VersionJson) -> Result<(), String> {
    let dir = natives_dir(root, &version.id);
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;

    for lib in active_libraries(version) {
        let Some(classifier) = native_classifier(lib) else {
            continue;
        };
        let Some(classifiers) = lib.downloads.classifiers.as_ref() else {
            continue;
        };
        let Some(artifact) = classifiers.get(&classifier) else {
            continue;
        };
        let jar_path = root.join("libraries").join(&artifact.path);
        if !jar_path.exists() {
            continue;
        }
        extract_zip(&jar_path, &dir)?;
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

    for lib in loader.libraries.iter().filter(|l| rules_allow(&l.rules)) {
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
    let assets_dir = root.join("assets");
    let mut args = if let Some(arguments) = version.arguments.as_ref() {
        arguments
            .game
            .iter()
            .filter_map(argument_value)
            .collect::<Vec<_>>()
    } else {
        version
            .minecraft_arguments
            .clone()
            .unwrap_or_else(|| legacy_default_args().join(" "))
            .split_whitespace()
            .map(|s| s.to_string())
            .collect::<Vec<_>>()
    };

    let replacements = HashMap::from([
        ("${auth_player_name}", profile.name.clone()),
        ("${version_name}", version.id.clone()),
        ("${game_directory}", game_dir.to_string_lossy().to_string()),
        ("${assets_root}", assets_dir.to_string_lossy().to_string()),
        ("${assets_index_name}", version.asset_index.id.clone()),
        ("${auth_uuid}", profile.id.clone()),
        ("${auth_access_token}", access_token.to_string()),
        ("${user_type}", "msa".to_string()),
        ("${version_type}", version.version_type.clone()),
        ("${clientid}", "".to_string()),
        ("${auth_xuid}", "".to_string()),
    ]);

    for arg in &mut args {
        if let Some(value) = replacements.get(arg.as_str()) {
            *arg = value.clone();
        }
    }
    args
}

fn argument_value(value: &Value) -> Option<String> {
    match value {
        Value::String(s) => Some(s.clone()),
        // Условные аргументы (feature/OS rules) пока пропускаем. Для NeoForge на
        // десктопе они не требуются — jvm/game-аргументы там простые строки.
        Value::Object(_) => None,
        _ => None,
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

    arguments
        .jvm
        .iter()
        .filter_map(argument_value)
        .map(|arg| substitute_tokens(&arg, &replacements))
        .collect()
}

/// FML-аргументы игры из профиля NeoForge (`--fml.neoForgeVersion`,
/// `--launchTarget forgeclient` и т.д.). Плейсхолдеров там нет.
fn modloader_game_args(loader: &ModLoaderProfile) -> Vec<String> {
    let Some(arguments) = loader.arguments.as_ref() else {
        return Vec::new();
    };
    arguments.game.iter().filter_map(argument_value).collect()
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
        .filter(|lib| rules_allow(&lib.rules))
}

fn rules_allow(rules: &Option<Vec<Rule>>) -> bool {
    let Some(rules) = rules else { return true };
    let mut allowed = false;
    for rule in rules {
        if rule.matches_current_os() {
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
    if marker.exists() {
        return Ok(profile_id);
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
            eprintln!(
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
        if let Err(e) = download_to(progress, http, &url, &installer, "NeoForge installer", None, None).await {
            last_err = e;
            eprintln!("[neoforge] ошибка скачивания installer (попытка {attempt}): {last_err}");
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
            eprintln!(
                "[neoforge] запускаем installer {} -> {}",
                installer_clone.display(),
                root_clone.display()
            );
            let mut command = Command::new(&java_clone);
            command
                .arg("-Dhttps.proxyHost=assets.zeragorn.xyz")
                .arg("-Dhttps.proxyPort=3128")
                .arg("-Dhttp.proxyHost=assets.zeragorn.xyz")
                .arg("-Dhttp.proxyPort=3128")
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
                eprintln!(
                    "[neoforge-{}] stdout: {}",
                    neoforge_version_clone,
                    String::from_utf8_lossy(&output.stdout).trim_end()
                );
            }
            if !output.stderr.is_empty() {
                eprintln!(
                    "[neoforge-{}] stderr: {}",
                    neoforge_version_clone,
                    String::from_utf8_lossy(&output.stderr).trim_end()
                );
            }
            eprintln!(
                "[neoforge] installer завершился со статусом {}",
                output.status
            );
            Ok(output.status)
        })
        .await
        .map_err(|e| format!("Ошибка потока NeoForge installer: {e}"))?
        .map_err(|e: String| e)?;

        if !status.success() {
            last_err = format!(
                "NeoForge installer завершился с ошибкой ({status}). Проверь Java 21+ и логи консоли"
            );
            eprintln!("[neoforge] ошибка установки (попытка {attempt}): {last_err}");
            continue;
        }
        if !marker.exists() {
            last_err =
                "NeoForge installer отработал, но профиль не появился в versions/".to_string();
            eprintln!("[neoforge] маркер не появился (попытка {attempt}): {last_err}");
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
    let xml = http
        .get(NEOFORGE_METADATA_URL)
        .send()
        .await
        .map_err(network_error)?
        .error_for_status()
        .map_err(|e| format!("Не удалось получить версии NeoForge: {e}"))?
        .text()
        .await
        .map_err(network_error)?;

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
    if let Err(e) = download_to(progress, http, &admin_url, &jar, "authlib-injector", None, None).await {
        eprintln!("admin-server не отдал authlib-injector ({e}), пробую апстрим");
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
        ).await?;
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
    download_inner(progress, http, url, path, label, DownloadScope::Stage, expected_sha1, expected_size).await
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
    download_inner(progress, http, url, path, label, DownloadScope::Item, expected_sha1, expected_size).await
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
    use std::io::Write;

    const MAX_ATTEMPTS: u32 = 3;

    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }

    let tmp = path.with_extension("download");
    let mut last_err = String::new();

    for attempt in 1..=MAX_ATTEMPTS {
        if attempt > 1 {
            eprintln!("[download] повтор {attempt}/{MAX_ATTEMPTS}: {url}");
            let _ = tauri::async_runtime::spawn_blocking(|| {
                std::thread::sleep(std::time::Duration::from_secs(2));
            })
            .await;
        }

        let resp = match http.get(url).send().await {
            Ok(r) => r,
            Err(e) => {
                last_err = format!("Сетевая ошибка при скачивании {url}: {e}");
                eprintln!("[download] ошибка (попытка {attempt}): {last_err}");
                continue;
            }
        };
        let mut resp = match resp.error_for_status() {
            Ok(r) => r,
            Err(e) => {
                last_err = format!("Не удалось скачать {url}: {e}");
                eprintln!("[download] HTTP ошибка (попытка {attempt}): {last_err}");
                continue;
            }
        };

        let total = resp.content_length();
        let mut file = match fs::File::create(&tmp) {
            Ok(f) => f,
            Err(e) => {
                return Err(format!(
                    "Не удалось создать временный файл {}: {e}",
                    tmp.display()
                ))
            }
        };
        let mut downloaded = 0u64;
        let started = Instant::now();
        if let DownloadScope::Stage = scope {
            progress.set_label("downloading", format!("Скачиваем {label}"));
            progress.download_tick(downloaded, total, started);
        }

        let mut chunk_err: Option<String> = None;
        loop {
            match resp.chunk().await {
                Ok(Some(chunk)) => {
                    if let Err(e) = file.write_all(&chunk) {
                        return Err(e.to_string());
                    }
                    downloaded += chunk.len() as u64;
                    match scope {
                        DownloadScope::Stage => progress.download_tick(downloaded, total, started),
                        DownloadScope::Item => progress.add_bytes(chunk.len() as u64),
                    }
                }
                Ok(None) => break,
                Err(e) => {
                    chunk_err = Some(format!("Обрыв при скачивании {url}: {e}"));
                    break;
                }
            }
        }

        if let Some(e) = chunk_err {
            last_err = e;
            eprintln!("[download] обрыв (попытка {attempt}): {last_err}");
            let _ = fs::remove_file(&tmp);
            continue;
        }

        if let Err(e) = file.flush() {
            return Err(e.to_string());
        }
        drop(file);

        // Верификация размера.
        if let Some(expected) = expected_size {
            if downloaded != expected {
                last_err = format!(
                    "Размер {label}: скачано {downloaded} байт, ожидалось {expected}"
                );
                eprintln!("[download] неверный размер (попытка {attempt}): {last_err}");
                let _ = fs::remove_file(&tmp);
                continue;
            }
        }
        // Проверка Content-Length, если сервер его прислал.
        if let Some(cl) = total {
            if downloaded != cl {
                last_err = format!(
                    "Размер {label}: скачано {downloaded} байт, Content-Length {cl}"
                );
                eprintln!("[download] size mismatch (попытка {attempt}): {last_err}");
                let _ = fs::remove_file(&tmp);
                continue;
            }
        }

        // Верификация SHA-1.
        if let Some(expected) = expected_sha1 {
            let actual = tauri::async_runtime::spawn_blocking({
                let tmp = tmp.clone();
                move || compute_sha1(&tmp)
            })
            .await
            .map_err(|e| format!("Ошибка потока при хешировании: {e}"))?;
            match actual {
                Ok(hash) if hash.eq_ignore_ascii_case(expected) => {}
                Ok(hash) => {
                    last_err = format!(
                        "SHA-1 {label}: получен {hash}, ожидался {expected}"
                    );
                    eprintln!("[download] неверный хеш (попытка {attempt}): {last_err}");
                    let _ = fs::remove_file(&tmp);
                    continue;
                }
                Err(e) => {
                    last_err = format!("Не удалось вычислить SHA-1 {label}: {e}");
                    eprintln!("[download] ошибка хеша (попытка {attempt}): {last_err}");
                    let _ = fs::remove_file(&tmp);
                    continue;
                }
            }
        }

        fs::rename(&tmp, path).map_err(|e| {
            format!(
                "Не удалось переместить {} в {}: {e}",
                tmp.display(),
                path.display()
            )
        })?;
        eprintln!("[download] OK ({downloaded} байт): {url}");
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

fn compute_sha1(path: &Path) -> Result<String, String> {
    use sha1::{Digest, Sha1};
    let bytes =
        fs::read(path).map_err(|e| format!("Не удалось прочитать файл для хеша {}: {e}", path.display()))?;
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
}

#[derive(Debug, Deserialize)]
struct AssetIndex {
    objects: HashMap<String, AssetObject>,
}

#[derive(Debug, Deserialize)]
struct AssetObject {
    hash: String,
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

#[derive(Debug, Deserialize)]
struct Rule {
    action: String,
    #[serde(default)]
    os: Option<RuleOs>,
}

impl Rule {
    fn matches_current_os(&self) -> bool {
        let Some(os) = self.os.as_ref() else {
            return true;
        };
        let Some(name) = os.name.as_ref() else {
            return true;
        };
        name == current_os_name()
    }
}

#[derive(Debug, Deserialize)]
struct RuleOs {
    #[serde(default)]
    name: Option<String>,
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
    use std::io::Write;

    #[test]
    fn parse_java_major_old_style() {
        assert_eq!(
            parse_java_major("java version \"1.8.0_301\""),
            Some(8)
        );
    }

    #[test]
    fn parse_java_major_new_style() {
        assert_eq!(
            parse_java_major("openjdk version \"21.0.1\" 2024-04-16"),
            Some(21)
        );
    }

    #[test]
    fn parse_java_major_empty() {
        assert_eq!(parse_java_major(""), None);
    }

    #[test]
    fn parse_java_major_no_version() {
        assert_eq!(parse_java_major("some random text"), None);
    }

    #[test]
    fn substitute_tokens_basic() {
        let mut replacements: HashMap<&str, String> = HashMap::new();
        replacements.insert("${auth_player_name}", "Steve".to_string());
        replacements.insert("${version_name}", "1.21.1".to_string());
        let result = substitute_tokens("--username ${auth_player_name} --version ${version_name}", &replacements);
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
        assert!(rules_allow(&None));
    }

    #[test]
    fn rules_allow_empty_rules() {
        assert!(!rules_allow(&Some(vec![])));
    }

    #[test]
    fn extract_java_zip_rejects_slip() {
        let dir = std::env::temp_dir().join("stardust_test_zip_slip");
        let _ = std::fs::create_dir_all(&dir);
        let target = dir.join("target");
        let _ = std::fs::create_dir_all(&target);

        // Create a zip with a malicious entry that tries to escape.
        let zip_path = dir.join("malicious.zip");
        {
            let file = fs::File::create(&zip_path).unwrap();
            let mut zip = zip::ZipWriter::new(file);
            let options = zip::write::SimpleFileOptions::default()
                .compression_method(zip::CompressionMethod::Stored);
            // This entry tries to write outside the target directory.
            zip.start_file("jdk/bin/../../etc/passwd", options).unwrap();
            zip.write_all(b"malicious").unwrap();
            zip.finish().unwrap();
        }

        let result = extract_java_zip(&zip_path, &target);
        assert!(result.is_err());
        let err = result.unwrap_err();
        assert!(err.contains("Небезопасный путь"), "Error was: {err}");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn extract_java_zip_accepts_valid() {
        let dir = std::env::temp_dir().join("stardust_test_zip_valid");
        let _ = std::fs::create_dir_all(&dir);
        let target = dir.join("target");
        let _ = std::fs::create_dir_all(&target);

        let zip_path = dir.join("valid.zip");
        {
            let file = fs::File::create(&zip_path).unwrap();
            let mut zip = zip::ZipWriter::new(file);
            let options = zip::write::SimpleFileOptions::default()
                .compression_method(zip::CompressionMethod::Stored);
            zip.start_file("jdk/bin/java", options).unwrap();
            zip.write_all(b"fake java binary").unwrap();
            zip.finish().unwrap();
        }

        let result = extract_java_zip(&zip_path, &target);
        assert!(result.is_ok(), "Error: {:?}", result.err());
        assert!(target.join("bin/java").exists());

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn compute_sha1_known_input() {
        let dir = std::env::temp_dir().join("stardust_test_sha1");
        let _ = std::fs::create_dir_all(&dir);
        let path = dir.join("hello.txt");
        std::fs::write(&path, b"hello world").unwrap();
        let hash = compute_sha1(&path).unwrap();
        // SHA-1 of "hello world" is well-known.
        assert_eq!(
            hash,
            "2aae6c35c94fcfb415dbe95f408b9ce91ee846ed"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }
}
