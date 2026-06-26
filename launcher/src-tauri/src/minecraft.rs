//! Минимальный запуск Minecraft-клиента из лаунчера.
//!
//! Это первая рабочая итерация: vanilla-клиент скачивается в папку данных
//! лаунчера, затем запускается с нашим ником, UUID и accessToken. Следующим
//! шагом сюда добавятся Fabric/моды и authlib-injector/Yggdrasil.

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Child, Command};

#[cfg(windows)]
use std::os::windows::process::CommandExt;
use std::time::Instant;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Emitter};

use protocol::PlayerProfile;

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
    profile: PlayerProfile,
    access_token: String,
) -> Result<Child, String> {
    let root = data_dir.join("minecraft");
    let version_id =
        std::env::var("LAUNCHER_MC_VERSION").unwrap_or_else(|_| DEFAULT_VERSION.into());
    fs::create_dir_all(&root).map_err(|e| format!("Не удалось создать папку Minecraft: {e}"))?;
    let java = ensure_java(&app, http, &data_dir).await?;

    emit_step(
        &app,
        "checking",
        "Проверяем Minecraft 1.21.1 + NeoForge…",
        None,
    );

    let version = ensure_version(&app, http, &root, &version_id).await?;
    ensure_client(&app, http, &root, &version).await?;
    ensure_libraries(&app, http, &root, &version).await?;
    ensure_assets(&app, http, &root, &version).await?;
    let neoforge_id = ensure_neoforge(&app, http, &root, &java).await?;
    let loader = load_modloader_profile(&root, &neoforge_id)?;
    if loader.inherits_from != version.id {
        return Err(format!(
            "NeoForge профиль наследуется от {}, а запускаем {} — версии не совпадают",
            loader.inherits_from, version.id
        ));
    }
    emit_step(&app, "checking", "Скачиваем библиотеки NeoForge…", None);
    download_libraries(&app, http, &root, &loader.libraries).await?;
    emit_step(&app, "extracting", "Распаковываем native-библиотеки…", None);
    extract_natives(&root, &version)?;

    let game_dir = root.join("game");
    fs::create_dir_all(&game_dir).map_err(|e| format!("Не удалось создать папку игры: {e}"))?;

    // Синхронизируем активную сборку (моды/конфиги) в игровой каталог.
    // Если активной сборки нет — функция тихо вернётся, запустим без модпака.
    crate::modpack::sync(&app, http, &data_dir, &game_dir).await?;

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

    // authlib-injector: перенаправляет аутентификацию и текстуры на наш
    // auth-сервер, чтобы в игре отображался кастомный скин. Javaagent должен
    // идти среди JVM-аргументов (до main-класса). Если инжектор недоступен —
    // не валим запуск целиком: одиночная игра останется рабочей.
    let auth_url = crate::backend::base_url();
    match ensure_authlib_injector(&app, http, &data_dir).await {
        Ok(jar) => {
            args.push(format!("-javaagent:{}={}", jar.to_string_lossy(), auth_url));
            if let Some(meta) = prefetch_yggdrasil_meta(http, &auth_url).await {
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

    emit_step(&app, "launching", "Запускаем Minecraft…", Some(1.0));

    let mut command = Command::new(java);
    command.args(&args).current_dir(&game_dir);
    hide_console(&mut command);

    let child = command
        .spawn()
        .map_err(|e| format!("Не удалось запустить Java/Minecraft: {e}"))?;

    Ok(child)
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProgressPayload {
    phase: String,
    label: String,
    fraction: Option<f64>,
    downloaded_bytes: Option<u64>,
    total_bytes: Option<u64>,
    speed_bytes_per_sec: Option<f64>,
    eta_seconds: Option<f64>,
}

pub(crate) fn emit_step(
    app: &AppHandle,
    phase: &str,
    label: impl Into<String>,
    fraction: Option<f64>,
) {
    let _ = app.emit(
        "launcher://progress",
        ProgressPayload {
            phase: phase.to_string(),
            label: label.into(),
            fraction,
            downloaded_bytes: None,
            total_bytes: None,
            speed_bytes_per_sec: None,
            eta_seconds: None,
        },
    );
}

fn emit_download(
    app: &AppHandle,
    label: impl Into<String>,
    downloaded: u64,
    total: Option<u64>,
    started: Instant,
) {
    let elapsed = started.elapsed().as_secs_f64().max(0.001);
    let speed = downloaded as f64 / elapsed;
    let fraction = total.map(|t| (downloaded as f64 / t.max(1) as f64).clamp(0.0, 1.0));
    let eta = total.and_then(|t| {
        if speed > 1.0 && t > downloaded {
            Some((t - downloaded) as f64 / speed)
        } else {
            None
        }
    });
    let _ = app.emit(
        "launcher://progress",
        ProgressPayload {
            phase: "downloading".into(),
            label: label.into(),
            fraction,
            downloaded_bytes: Some(downloaded),
            total_bytes: total,
            speed_bytes_per_sec: Some(speed),
            eta_seconds: eta,
        },
    );
}

async fn ensure_java(
    app: &AppHandle,
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

    emit_step(app, "downloading", "Скачиваем приватную Java 21…", None);
    fs::create_dir_all(&runtime_dir)
        .map_err(|e| format!("Не удалось создать runtime Java: {e}"))?;
    let archive = data_dir.join("runtime").join("java-21.zip");
    download_to(app, http, TEMURIN_API_URL, &archive, "Java 21 runtime").await?;
    emit_step(app, "extracting", "Распаковываем Java 21…", None);
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
        let out = target.join(stripped);
        if let Some(parent) = out.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let mut out_file = fs::File::create(out).map_err(|e| e.to_string())?;
        std::io::copy(&mut file, &mut out_file).map_err(|e| e.to_string())?;
    }
    Ok(())
}

async fn ensure_version(
    app: &AppHandle,
    http: &reqwest::Client,
    root: &Path,
    version_id: &str,
) -> Result<VersionJson, String> {
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
        download_to(app, http, &entry.url, &version_path, "version json").await?;
    }

    let json = fs::read_to_string(&version_path)
        .map_err(|e| format!("Не удалось прочитать version json: {e}"))?;
    serde_json::from_str(&json).map_err(|e| format!("Некорректный version json: {e}"))
}

async fn ensure_client(
    app: &AppHandle,
    http: &reqwest::Client,
    root: &Path,
    version: &VersionJson,
) -> Result<(), String> {
    let path = client_jar(root, &version.id);
    if !path.exists() {
        let Some(client) = version.downloads.get("client") else {
            return Err("В version json нет client jar".into());
        };
        download_to(app, http, &client.url, &path, "client jar").await?;
    }
    Ok(())
}

async fn ensure_libraries(
    app: &AppHandle,
    http: &reqwest::Client,
    root: &Path,
    version: &VersionJson,
) -> Result<(), String> {
    download_libraries(app, http, root, &version.libraries).await
}

/// Скачивает произвольный список библиотек (vanilla или NeoForge),
/// учитывая OS-rules и native-классификаторы.
async fn download_libraries(
    app: &AppHandle,
    http: &reqwest::Client,
    root: &Path,
    libraries: &[Library],
) -> Result<(), String> {
    for lib in libraries.iter().filter(|lib| rules_allow(&lib.rules)) {
        if let Some(artifact) = lib.downloads.artifact.as_ref() {
            let path = root.join("libraries").join(&artifact.path);
            if !path.exists() && !artifact.url.is_empty() {
                download_to(app, http, &artifact.url, &path, &artifact.path).await?;
            }
        }
        if let Some(classifiers) = lib.downloads.classifiers.as_ref() {
            if let Some(native_key) = native_classifier(lib) {
                if let Some(artifact) = classifiers.get(&native_key) {
                    let path = root.join("libraries").join(&artifact.path);
                    if !path.exists() && !artifact.url.is_empty() {
                        download_to(app, http, &artifact.url, &path, &artifact.path).await?;
                    }
                }
            }
        }
    }
    Ok(())
}

async fn ensure_assets(
    app: &AppHandle,
    http: &reqwest::Client,
    root: &Path,
    version: &VersionJson,
) -> Result<(), String> {
    let indexes = root.join("assets").join("indexes");
    fs::create_dir_all(&indexes).map_err(|e| e.to_string())?;
    let index_path = indexes.join(format!("{}.json", version.asset_index.id));
    if !index_path.exists() {
        download_to(
            app,
            http,
            &version.asset_index.url,
            &index_path,
            "asset index",
        )
        .await?;
    }

    let json = fs::read_to_string(&index_path)
        .map_err(|e| format!("Не удалось прочитать asset index: {e}"))?;
    let index: AssetIndex =
        serde_json::from_str(&json).map_err(|e| format!("Некорректный asset index: {e}"))?;
    for object in index.objects.values() {
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
            download_to(app, http, &url, &path, "assets").await?;
        }
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
    app: &AppHandle,
    http: &reqwest::Client,
    root: &Path,
    java: &Path,
) -> Result<String, String> {
    let requested = std::env::var("LAUNCHER_NEOFORGE_VERSION").ok();
    let neoforge_version = match requested {
        Some(v) if !v.trim().is_empty() => v,
        _ => latest_neoforge_21_1(http).await?,
    };
    let profile_id = format!("neoforge-{neoforge_version}");
    let installer_dir = root
        .join("installers")
        .join("neoforge")
        .join(&neoforge_version);
    let installer = installer_dir.join(format!("neoforge-{neoforge_version}-installer.jar"));
    if !installer.exists() {
        let url = format!(
            "https://maven.neoforged.net/releases/net/neoforged/neoforge/{0}/neoforge-{0}-installer.jar",
            neoforge_version
        );
        download_to(app, http, &url, &installer, "NeoForge installer").await?;
    }

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

    emit_step(
        app,
        "extracting",
        format!("Устанавливаем NeoForge {neoforge_version}…"),
        None,
    );
    let mut command = Command::new(java);
    command
        .arg("-jar")
        .arg(&installer)
        .arg("--install-client")
        .arg(root)
        .current_dir(root);
    hide_console(&mut command);
    let status = command
        .status()
        .map_err(|e| format!("Не удалось запустить NeoForge installer: {e}"))?;
    if !status.success() {
        return Err(format!(
            "NeoForge installer завершился с ошибкой ({status}). Проверь Java 21+"
        ));
    }
    if !marker.exists() {
        return Err("NeoForge installer отработал, но профиль не появился в versions/".into());
    }
    Ok(profile_id)
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

/// Скачивает (и кэширует) authlib-injector.jar в папку данных лаунчера.
///
/// Источник по умолчанию — наш admin-server (`/authlib-injector.jar`): он
/// проксирует и кэширует апстрим, поэтому клиенту не нужен прямой доступ к
/// `yushi.moe`. Если admin-server недоступен — падаем на апстрим напрямую.
async fn ensure_authlib_injector(
    app: &AppHandle,
    http: &reqwest::Client,
    data_dir: &Path,
) -> Result<PathBuf, String> {
    let jar = data_dir.join("authlib-injector.jar");
    if jar.exists() {
        return Ok(jar);
    }
    emit_step(app, "checking", "Загружаем authlib-injector…", None);

    let admin_url = format!("{}/authlib-injector.jar", crate::backend::admin_base_url());
    if let Err(e) = download_to(app, http, &admin_url, &jar, "authlib-injector").await {
        eprintln!("admin-server не отдал authlib-injector ({e}), пробую апстрим");
        let url = upstream_injector_url(http).await?;
        download_to(app, http, &url, &jar, "authlib-injector").await?;
    }
    Ok(jar)
}

/// Узнаёт прямой URL свежего authlib-injector.jar у апстрима (`latest.json`).
async fn upstream_injector_url(http: &reqwest::Client) -> Result<String, String> {
    let meta: Value = http
        .get(AUTHLIB_INJECTOR_LATEST)
        .send()
        .await
        .map_err(network_error)?
        .error_for_status()
        .map_err(|e| format!("Не удалось получить метаданные authlib-injector: {e}"))?
        .json()
        .await
        .map_err(network_error)?;
    meta.get("download_url")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .ok_or_else(|| "В ответе authlib-injector отсутствует download_url".to_string())
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

pub(crate) async fn download_to(
    app: &AppHandle,
    http: &reqwest::Client,
    url: &str,
    path: &Path,
    label: &str,
) -> Result<(), String> {
    use std::io::Write;

    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let mut resp = http
        .get(url)
        .send()
        .await
        .map_err(network_error)?
        .error_for_status()
        .map_err(|e| format!("Не удалось скачать {url}: {e}"))?;
    let total = resp.content_length();
    let tmp = path.with_extension("download");
    let mut file = fs::File::create(&tmp)
        .map_err(|e| format!("Не удалось создать временный файл {}: {e}", tmp.display()))?;
    let mut downloaded = 0u64;
    let started = Instant::now();
    emit_download(
        app,
        format!("Скачиваем {label}"),
        downloaded,
        total,
        started,
    );

    while let Some(chunk) = resp.chunk().await.map_err(network_error)? {
        file.write_all(&chunk).map_err(|e| e.to_string())?;
        downloaded += chunk.len() as u64;
        emit_download(
            app,
            format!("Скачиваем {label}"),
            downloaded,
            total,
            started,
        );
    }
    file.flush().map_err(|e| e.to_string())?;
    fs::rename(&tmp, path).map_err(|e| {
        format!(
            "Не удалось переместить {} в {}: {e}",
            tmp.display(),
            path.display()
        )
    })?;
    Ok(())
}

fn network_error(e: reqwest::Error) -> String {
    if e.is_connect() {
        "Не удалось подключиться к серверу загрузки Minecraft".into()
    } else if e.is_timeout() {
        "Сервер загрузки Minecraft не отвечает".into()
    } else {
        format!("Сетевая ошибка: {e}")
    }
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
