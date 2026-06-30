//! Запуск Minecraft — использует файлы уже скачанные Tauri лаунчером.
//!
//! Читает version JSON, библиотеки, assets из общей папки minecraft/.
//! Если файлов нет — просит запустить стабильный лаунчер для скачивания.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use tokio::process::Command;

#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;

const JAVA_DIR: &str = "runtime/java-21";
const JAVA_EXE: &str = if cfg!(target_os = "windows") {
    "bin/javaw.exe"
} else {
    "bin/java"
};
const DEFAULT_VERSION: &str = "1.21.4";

// ─── Version JSON (_minimal) ───────────────────────────────

#[derive(serde::Deserialize)]
struct VersionJson {
    id: String,
    #[serde(default)]
    arguments: Option<VersionArguments>,
    #[serde(default)]
    minecraft_arguments: Option<String>,
    libraries: Vec<Library>,
    asset_index: AssetIndex,
    #[serde(default)]
    version_type: String,
}

fn default_version_type() -> String { "release".to_string() }

#[derive(serde::Deserialize)]
struct VersionArguments {
    #[serde(default)]
    game: Vec<serde_json::Value>,
    #[serde(default)]
    jvm: Vec<serde_json::Value>,
}

#[derive(serde::Deserialize)]
struct Library {
    name: String,
    #[serde(default)]
    downloads: LibraryDownloads,
    #[serde(default)]
    rules: Option<Vec<Rule>>,
    #[serde(default)]
    extract: Option<Extract>,
}

#[derive(serde::Deserialize, Default)]
struct LibraryDownloads {
    artifact: Option<Artifact>,
    #[serde(default)]
    classifiers: HashMap<String, Artifact>,
}

#[derive(serde::Deserialize)]
struct Artifact {
    path: String,
}

#[derive(serde::Deserialize)]
struct Rule {
    action: String,
    #[serde(default)]
    os: Option<RuleOs>,
}

#[derive(serde::Deserialize)]
struct RuleOs {
    name: Option<String>,
}

#[derive(serde::Deserialize)]
struct Extract {
    #[serde(default)]
    exclude: Vec<String>,
}

#[derive(serde::Deserialize)]
struct AssetIndex {
    id: String,
}

// ─── ModLoader Profile (NeoForge) ─────────────────────────

#[derive(serde::Deserialize)]
struct ModLoaderProfile {
    #[serde(default)]
    main_class: String,
    #[serde(default)]
    inherits_from: String,
    #[serde(default)]
    libraries: Vec<Library>,
    #[serde(default)]
    arguments: Option<VersionArguments>,
}

// ─── Public API ────────────────────────────────────────────

pub struct LaunchArgs {
    pub username: String,
    pub uuid: String,
    pub access_token: String,
    pub client_token: String,
    pub memory_mb: u32,
    pub game_dir: PathBuf,
    pub data_dir: PathBuf,
    pub server: Option<String>,
}

pub async fn launch(args: &LaunchArgs) -> Result<u32, String> {
    let root = args.data_dir.join("minecraft");
    let game_dir = &args.game_dir;

    // Java
    let java = find_java(&args.data_dir)
        .ok_or("Java не найдена. Запусти стабильный лаунчер для скачивания Java 21.")?;

    // Version JSON
    let version_id = detect_version(&root)
        .ok_or("Версия Minecraft не найдена. Запусти стабильный лаунчер.")?;

    let version_json = load_version_json(&root, &version_id)?;

    // NeoForge?
    let loader = find_modloader_profile(&root);

    // Classpath
    let classpath = build_classpath(&root, &version_json, loader.as_ref());

    // Natives
    let natives = extract_natives_if_needed(&root, &version_id);

    // JVM args
    let mut jvm_args = Vec::new();
    jvm_args.push(format!("-Xmx{}M", args.memory_mb));
    jvm_args.push(format!("-Djava.library.path={}", natives.to_string_lossy()));

    // Proxy args
    jvm_args.push("-Dhttp.proxyHost=assets.zeragorn.xyz".into());
    jvm_args.push("-Dhttp.proxyPort=3128".into());
    jvm_args.push("-Dhttps.proxyHost=assets.zeragorn.xyz".into());
    jvm_args.push("-Dhttps.proxyPort=3128".into());

    // authlib-injector
    let authlib_jar = args.data_dir.join("authlib-injector.jar");
    if authlib_jar.exists() {
        let auth_url = std::env::var("LAUNCHER_AUTH_URL")
            .unwrap_or_else(|_| "https://auth.zeragorn.xyz".to_string());
        jvm_args.push(format!("-javaagent:{}={}", authlib_jar.to_string_lossy(), auth_url));

        // Prefetch yggdrasil meta
        if let Some(meta) = prefetch_yggdrasil_meta(&auth_url).await {
            jvm_args.push(format!("-Dauthlibinjector.yggdrasil.prefetched={meta}"));
        }
    }

    // NeoForge JVM args
    if let Some(ref l) = loader {
        jvm_args.extend(modloader_jvm_args(&root, &version_json, l));
    }

    jvm_args.push("-cp".into());
    jvm_args.push(classpath);

    // Main class
    let main_class = if let Some(ref l) = loader {
        if !l.main_class.is_empty() {
            l.main_class.clone()
        } else {
            version_json
                .arguments
                .as_ref()
                .and_then(|a| a.jvm.iter().find_map(|v| {
                    if let serde_json::Value::String(s) = v {
                        if s == "${main_class}" {
                            None
                        } else {
                            None
                        }
                    } else {
                        None
                    }
                }))
                .unwrap_or_else(|| "net.minecraft.client.main.Main".to_string())
        }
    } else {
        "net.minecraft.client.main.Main".to_string()
    };
    jvm_args.push(main_class);

    // Game args
    jvm_args.extend(game_args(&version_json, game_dir, &args.username, &args.uuid, &args.access_token));

    // NeoForge game args
    if let Some(ref l) = loader {
        jvm_args.extend(modloader_game_args(l));
    }

    // Server
    if let Some(ref server) = args.server {
        jvm_args.push("--server".into());
        jvm_args.push(server.clone());
    }

    // Запуск
    let mut cmd = Command::new(&java);
    cmd.args(&jvm_args).current_dir(game_dir);

    #[cfg(windows)]
    {
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    let child = cmd
        .spawn()
        .map_err(|e| format!("Запуск Java: {e}"))?;

    Ok(child.id().unwrap_or(0))
}

// ─── Helpers ───────────────────────────────────────────────

fn find_java(data_dir: &Path) -> Option<PathBuf> {
    let java = data_dir.join(JAVA_DIR).join(JAVA_EXE);
    if java.exists() {
        Some(java)
    } else {
        // Попробуем найти системную Java 21
        #[cfg(not(target_os = "windows"))]
        {
            let output = std::process::Command::new("java")
                .arg("-version")
                .output()
                .ok()?;
            let stderr = String::from_utf8_lossy(&output.stderr);
            if stderr.contains("21.") {
                Some(PathBuf::from("java"))
            } else {
                None
            }
        }
        #[cfg(target_os = "windows")]
        None
    }
}

fn detect_version(root: &Path) -> Option<String> {
    let versions_dir = root.join("versions");
    if !versions_dir.exists() {
        return None;
    }
    let mut found = None;
    let entries: Vec<_> = std::fs::read_dir(&versions_dir)
        .ok()
        .map(|rd| rd.flatten().collect())
        .unwrap_or_default();
    for entry in entries {
        let p = entry.path();
        if p.extension().and_then(|e| e.to_str()) == Some("json") {
            let name = p.file_stem().and_then(|f| f.to_str()).unwrap_or("");
            found = Some(name.to_string());
        }
    }
    found
}

fn load_version_json(root: &Path, version_id: &str) -> Result<VersionJson, String> {
    let path = root.join("versions").join(format!("{version_id}.json"));
    let content = std::fs::read_to_string(&path)
        .map_err(|e| format!("Чтение {version_id}.json: {e}"))?;
    serde_json::from_str(&content)
        .map_err(|e| format!("Парсинг {version_id}.json: {e}"))
}

fn find_modloader_profile(root: &Path) -> Option<ModLoaderProfile> {
    let versions_dir = root.join("versions");
    for entry in (std::fs::read_dir(&versions_dir).ok()?).flatten() {
        let p = entry.path();
        if p.extension().and_then(|e| e.to_str()) == Some("json") {
            if let Ok(content) = std::fs::read_to_string(&p) {
                if let Ok(v) = serde_json::from_str::<serde_json::Value>(&content) {
                    if v.get("inherits_from").is_some() {
                        if let Ok(profile) = serde_json::from_str::<ModLoaderProfile>(&content) {
                            return Some(profile);
                        }
                    }
                }
            }
        }
    }
    None
}

fn build_classpath(root: &Path, vanilla: &VersionJson, loader: Option<&ModLoaderProfile>) -> String {
    let mut paths = Vec::new();
    let mut seen = std::collections::HashSet::new();

    // Modloader libraries
    if let Some(l) = loader {
        for lib in &l.libraries {
            if !rules_allow(&lib.rules) {
                continue;
            }
            if let Some(ref artifact) = lib.downloads.artifact {
                let key = dedup_key(&lib.name);
                seen.insert(key);
                paths.push(root.join("libraries").join(&artifact.path));
            }
        }
    }

    // Vanilla libraries
    for lib in &vanilla.libraries {
        if !rules_allow(&lib.rules) {
            continue;
        }
        if let Some(ref artifact) = lib.downloads.artifact {
            let key = dedup_key(&lib.name);
            if seen.contains(&key) {
                continue;
            }
            paths.push(root.join("libraries").join(&artifact.path));
        }
    }

    // Client jar
    let client = root
        .join("versions")
        .join(&vanilla.id)
        .join(format!("{}.jar", vanilla.id));
    paths.push(client);

    let sep = if cfg!(target_os = "windows") { ";" } else { ":" };
    paths
        .iter()
        .map(|p| p.to_string_lossy().to_string())
        .collect::<Vec<_>>()
        .join(sep)
}

fn dedup_key(name: &str) -> String {
    let parts: Vec<&str> = name.split(':').collect();
    if parts.len() < 2 {
        return name.to_string();
    }
    let classifier = parts.get(3).copied().unwrap_or("");
    format!("{}:{}:{}", parts[0], parts[1], classifier)
}

fn rules_allow(rules: &Option<Vec<Rule>>) -> bool {
    let Some(rules) = rules else { return true };
    let mut allowed = false;
    for rule in rules {
        let matches = match rule.os.as_ref() {
            Some(os) => os.name.as_deref() == Some(current_os_name()),
            None => true,
        };
        if matches {
            allowed = rule.action == "allow";
        }
    }
    allowed
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

fn extract_natives_if_needed(root: &Path, version_id: &str) -> PathBuf {
    let natives = root.join("versions").join(version_id).join("natives");
    if natives.exists() {
        return natives;
    }
    let _ = std::fs::create_dir_all(&natives);

    // Пытаемся распаковать native jar'ы
    let _version_dir = root.join("versions").join(version_id);
    let lib_dir = root.join("libraries");

    if let Ok(v) = load_version_json(root, version_id) {
        for lib in &v.libraries {
            if !rules_allow(&lib.rules) {
                continue;
            }
            if let Some(ref extract) = lib.extract {
                if let Some(ref classifier) = lib.downloads.classifiers.get(native_classifier_key()) {
                    let jar_path = lib_dir.join(&classifier.path);
                    if jar_path.exists() {
                        let _ = extract_natives(&jar_path, &natives, &extract.exclude);
                    }
                }
            }
        }
    }

    natives
}

fn native_classifier_key() -> &'static str {
    if cfg!(target_os = "windows") && cfg!(target_arch = "x86_64") {
        "natives-windows"
    } else if cfg!(target_os = "linux") && cfg!(target_arch = "x86_64") {
        "natives-linux"
    } else if cfg!(target_os = "macos") && cfg!(target_arch = "aarch64") {
        "natives-macos"
    } else if cfg!(target_os = "macos") {
        "natives-osx"
    } else {
        "natives-windows"
    }
}

fn extract_natives(jar_path: &Path, target: &Path, exclude: &[String]) -> Result<(), String> {
    let file = std::fs::File::open(jar_path).map_err(|e| format!("Открытие: {e}"))?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| format!("Zip: {e}"))?;
    for i in 0..archive.len() {
        let entry = archive.by_index(i).map_err(|e| format!("Zip entry: {e}"))?;
        let name = entry.name().to_string();
        if exclude.iter().any(|ex| name.starts_with(ex.as_str())) {
            continue;
        }
        if name.ends_with('/') {
            continue;
        }
        let out_path = target.join(&name);
        if let Some(parent) = out_path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let mut out = std::fs::File::create(&out_path).map_err(|e| format!("Создание: {e}"))?;
        std::io::copy(&mut std::io::Read::take(entry, u64::MAX), &mut out)
            .map_err(|e| format!("Запись: {e}"))?;
    }
    Ok(())
}

fn game_args(
    version: &VersionJson,
    game_dir: &Path,
    username: &str,
    uuid: &str,
    access_token: &str,
) -> Vec<String> {
    let assets_dir = game_dir
        .parent()
        .unwrap_or(game_dir)
        .join("assets");

    let mut args = if let Some(ref arguments) = version.arguments {
        arguments
            .game
            .iter()
            .filter_map(|v| match v {
                serde_json::Value::String(s) => Some(s.clone()),
                _ => None,
            })
            .collect::<Vec<_>>()
    } else {
        version
            .minecraft_arguments
            .clone()
            .unwrap_or_else(|| {
                "--username ${auth_player_name} --version ${version_name} --gameDir ${game_directory} --assetsDir ${assets_root} --assetIndex ${assets_index_name} --uuid ${auth_uuid} --accessToken ${auth_access_token} --userType ${user_type} --versionType ${version_type}".to_string()
            })
            .split_whitespace()
            .map(|s| s.to_string())
            .collect::<Vec<_>>()
    };

    let replacements = HashMap::from([
        ("${auth_player_name}", username.to_string()),
        ("${version_name}", version.id.clone()),
        ("${game_directory}", game_dir.to_string_lossy().to_string()),
        ("${assets_root}", assets_dir.to_string_lossy().to_string()),
        ("${assets_index_name}", version.asset_index.id.clone()),
        ("${auth_uuid}", uuid.to_string()),
        ("${auth_access_token}", access_token.to_string()),
        ("${user_type}", "msa".to_string()),
        ("${version_type}", version.version_type.clone()),
        ("${clientid}", String::new()),
        ("${auth_xuid}", String::new()),
    ]);

    for arg in &mut args {
        if let Some(value) = replacements.get(arg.as_str()) {
            *arg = value.clone();
        }
    }
    args
}

fn modloader_jvm_args(root: &Path, vanilla: &VersionJson, loader: &ModLoaderProfile) -> Vec<String> {
    let Some(arguments) = loader.arguments.as_ref() else {
        return Vec::new();
    };
    let library_directory = root.join("libraries");
    let classpath_separator = if cfg!(windows) { ";" } else { ":" };
    let replacements = HashMap::from([
        ("${library_directory}", library_directory.to_string_lossy().to_string()),
        ("${classpath_separator}", classpath_separator.to_string()),
        ("${version_name}", vanilla.id.clone()),
    ]);

    arguments
        .jvm
        .iter()
        .filter_map(|v| match v {
            serde_json::Value::String(s) => Some(substitute_tokens(s, &replacements)),
            _ => None,
        })
        .collect()
}

fn modloader_game_args(loader: &ModLoaderProfile) -> Vec<String> {
    let Some(arguments) = loader.arguments.as_ref() else {
        return Vec::new();
    };
    arguments
        .game
        .iter()
        .filter_map(|v| match v {
            serde_json::Value::String(s) => Some(s.clone()),
            _ => None,
        })
        .collect()
}

fn substitute_tokens(input: &str, replacements: &HashMap<&str, String>) -> String {
    let mut result = input.to_string();
    for (token, value) in replacements {
        result = result.replace(token, value);
    }
    result
}

async fn prefetch_yggdrasil_meta(auth_url: &str) -> Option<String> {
    let http = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(5))
        .build()
        .ok()?;
    let bytes = http
        .get(format!("{auth_url}/"))
        .send()
        .await
        .ok()?
        .bytes()
        .await
        .ok()?;
    Some(base64::Engine::encode(
        &base64::engine::general_purpose::STANDARD,
        &bytes,
    ))
}
