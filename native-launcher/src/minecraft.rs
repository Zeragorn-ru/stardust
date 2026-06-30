//! Full Minecraft launch pipeline.
//!
//! Downloads Java, version manifest, client jar, libraries, assets,
//! NeoForge installer, and launches the game.

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Arc;
use std::time::Instant;

#[cfg(windows)]
use std::os::windows::process::CommandExt;

use futures_util::stream::{self, StreamExt};
use serde::Deserialize;
use sha1::{Digest, Sha1};

use crate::api::{LoaderKind, Manifest};
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
const AUTHLIB_INJECTOR_LATEST: &str = "https://authlib-injector.yushi.moe/artifact/latest.json";
const ADMIN_BASE: &str = "https://admin.zeragorn.xyz";
const PROXY_HOST: &str = "assets.zeragorn.xyz";
const PROXY_PORT: &str = "3128";
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;

const DOWNLOAD_MAX_ATTEMPTS: u32 = 5;
const CHUNK_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);

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
    pub download_concurrency: usize,
}

pub struct LaunchResult {
    pub pid: u32,
    pub progress: Arc<Progress>,
}

pub async fn launch(args: &LaunchArgs, progress: Arc<Progress>) -> Result<u32, String> {
    let root = args.data_dir.join("minecraft");
    let game_dir = &args.game_dir;
    let concurrency = args.download_concurrency.clamp(1, 16);

    let http = build_http_client();
    fs::create_dir_all(&root).map_err(|e| format!("Создание папки Minecraft: {e}"))?;

    // Stage 1: Java
    let java = ensure_java(&progress, &http, &args.data_dir).await?;

    // Stage 2: Version manifest
    let version_id =
        std::env::var("LAUNCHER_MC_VERSION").unwrap_or_else(|_| DEFAULT_VERSION.into());
    let version = ensure_version(&progress, &http, &root, &version_id).await?;

    // Stage 3: Client jar
    ensure_client(&progress, &http, &root, &version).await?;

    // Stage 4: Vanilla libraries
    ensure_libraries(&progress, &http, &root, &version, concurrency).await?;

    // Stage 5: Assets
    ensure_assets(&progress, &http, &root, &version, concurrency).await?;

    // Stage 6: NeoForge
    let pinned_neoforge = detect_neoforge_version(&args.data_dir);
    let neoforge_id =
        ensure_neoforge(&progress, &http, &root, &java, pinned_neoforge.as_deref()).await?;

    // Stage 7: NeoForge libraries
    let loader = load_modloader_profile(&root, &neoforge_id)?;
    if loader.inherits_from != version.id {
        return Err(format!(
            "NeoForge inherits_from mismatch: {} vs {}",
            loader.inherits_from, version.id
        ));
    }
    progress.begin(
        Stage::NeoForgeLibraries,
        "downloading",
        "Скачиваем библиотеки NeoForge…",
    );
    download_libraries(&progress, &http, &root, &loader.libraries, concurrency).await?;

    // Stage 8: Natives
    progress.begin(
        Stage::Natives,
        "extracting",
        "Распаковываем native-библиотеки…",
    );
    extract_natives(&root, &version)?;

    // Game dir
    fs::create_dir_all(game_dir).map_err(|e| format!("Создание папки игры: {e}"))?;

    // Stage 9: Modpack sync
    progress.begin(Stage::Modpack, "checking", "Проверяем сборку…");
    crate::modpack::sync_with_progress(
        &progress,
        &http,
        &args.data_dir,
        game_dir,
        concurrency as u32,
    )
    .await?;

    // Stage 10: Build args and launch
    let classpath = build_modloader_classpath(&root, &version, &loader);
    let natives_dir = natives_dir(&root, &version.id);

    let mut jvm_args = Vec::<String>::new();
    jvm_args.push(format!("-Xmx{}M", args.memory_mb));
    jvm_args.push(format!(
        "-Djava.library.path={}",
        natives_dir.to_string_lossy()
    ));

    // NeoForge JVM args
    jvm_args.extend(modloader_jvm_args(&root, &version, &loader));

    // Proxy
    jvm_args.push(format!("-Dhttp.proxyHost={PROXY_HOST}"));
    jvm_args.push(format!("-Dhttp.proxyPort={PROXY_PORT}"));
    jvm_args.push(format!("-Dhttps.proxyHost={PROXY_HOST}"));
    jvm_args.push(format!("-Dhttps.proxyPort={PROXY_PORT}"));

    // authlib-injector
    match ensure_authlib_injector(&progress, &http, &args.data_dir).await {
        Ok(jar) => {
            let auth_url = std::env::var("LAUNCHER_AUTH_URL")
                .unwrap_or_else(|_| "https://auth.zeragorn.xyz".to_string());
            jvm_args.push(format!("-javaagent:{}={}", jar.to_string_lossy(), auth_url));
            if let Some(meta) = prefetch_yggdrasil_meta(&http, &auth_url).await {
                jvm_args.push(format!("-Dauthlibinjector.yggdrasil.prefetched={meta}"));
            }
        }
        Err(e) => {
            eprintln!("authlib-injector недоступен: {e}");
        }
    }

    jvm_args.push("-cp".into());
    jvm_args.push(classpath);
    jvm_args.push(loader.main_class.clone());

    // Game args
    jvm_args.extend(game_args(
        &root,
        game_dir,
        &version,
        &args.username,
        &args.uuid,
        &args.access_token,
    ));
    jvm_args.extend(modloader_game_args(&loader));

    if let Some(ref server) = args.server {
        jvm_args.push("--server".into());
        jvm_args.push(server.clone());
    }

    progress.begin(Stage::Launch, "launching", "Запускаем Minecraft…");
    progress.set_stage_fraction(1.0);

    let mut command = Command::new(&java);
    command.args(&jvm_args).current_dir(game_dir);
    hide_console(&mut command);

    let child = command
        .spawn()
        .map_err(|e| format!("Запуск Java/Minecraft: {e}"))?;

    Ok(child.id())
}

// ─── Java ──────────────────────────────────────────────────

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
        return Err(
            "Java 21 не найдена. Установи Java 21 или задай JAVA_HOME".into(),
        );
    }

    progress.begin(Stage::Java, "downloading", "Скачиваем Java 21…");
    fs::create_dir_all(&runtime_dir)
        .map_err(|e| format!("Создание runtime Java: {e}"))?;
    let archive = data_dir.join("runtime").join("java-21.zip");
    download_to(progress, http, TEMURIN_API_URL, &archive, "Java 21", None, None).await?;
    progress.set_label("extracting", "Распаковываем Java 21…");
    extract_java_zip(&archive, &runtime_dir)?;
    let _ = fs::remove_file(&archive);

    bundled_java(&runtime_dir).ok_or_else(|| "Java скачана, но java не найдена".to_string())
}

fn bundled_java(runtime_dir: &Path) -> Option<PathBuf> {
    let exe = java_exe_name();
    let direct = runtime_dir.join("bin").join(exe);
    if direct.exists() {
        return Some(direct);
    }
    for entry in fs::read_dir(runtime_dir).ok()? {
        let path = entry.ok()?.path();
        let java = path.join("bin").join(java_exe_name());
        if java.exists() {
            return Some(java);
        }
    }
    None
}

fn java_exe_name() -> &'static str {
    if cfg!(windows) {
        "javaw.exe"
    } else {
        "java"
    }
}

fn system_java_21() -> Option<PathBuf> {
    if let Ok(home) = std::env::var("JAVA_HOME") {
        let path = PathBuf::from(home)
            .join("bin")
            .join(java_exe_name());
        if path.exists() && java_is_21(&path) {
            return Some(path);
        }
    }
    let java = PathBuf::from(java_exe_name());
    if java_is_21(&java) {
        Some(java)
    } else {
        None
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
        fs::File::open(archive).map_err(|e| format!("Открытие Java archive: {e}"))?;
    let mut zip =
        zip::ZipArchive::new(file).map_err(|e| format!("Некорректный Java zip: {e}"))?;
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
        if Path::new(stripped)
            .components()
            .any(|c| matches!(c, std::path::Component::ParentDir))
        {
            return Err(format!(
                "Небезопасный путь в zip: {name} (zip-slip)"
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

// ─── Version Manifest ──────────────────────────────────────

async fn ensure_version(
    progress: &Progress,
    http: &reqwest::Client,
    root: &Path,
    version_id: &str,
) -> Result<VersionJson, String> {
    progress.begin(
        Stage::Version,
        "checking",
        format!("Проверяем Minecraft {version_id}…"),
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
        download_to(progress, http, &entry.url, &version_path, "version json", None, None).await?;
    }
    progress.set_stage_fraction(1.0);

    let json = fs::read_to_string(&version_path)
        .map_err(|e| format!("Чтение version json: {e}"))?;
    serde_json::from_str(&json).map_err(|e| format!("Некорректный version json: {e}"))
}

// ─── Client Jar ────────────────────────────────────────────

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

// ─── Libraries ─────────────────────────────────────────────

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

// ─── Assets ────────────────────────────────────────────────

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
        .map_err(|e| format!("Чтение asset index: {e}"))?;
    let index: AssetIndexFull =
        serde_json::from_str(&json).map_err(|e| format!("Некорректный asset index: {e}"))?;

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

// ─── NeoForge ──────────────────────────────────────────────

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

    let marker = root
        .join("versions")
        .join(&profile_id)
        .join(format!("{profile_id}.json"));
    let patched_client = root
        .join("libraries")
        .join("net/neoforged/neoforge")
        .join(&neoforge_version)
        .join(format!("neoforge-{neoforge_version}-client.jar"));
    if marker.exists() && patched_client.exists() {
        return Ok(profile_id);
    }
    if marker.exists() {
        let _ = fs::remove_file(&marker);
    }

    // launcher_profiles.json required by installer
    let profiles_file = root.join("launcher_profiles.json");
    if !profiles_file.exists() {
        fs::write(
            &profiles_file,
            r#"{"profiles":{},"settings":{},"version":3}"#,
        )
        .map_err(|e| format!("Создание launcher_profiles.json: {e}"))?;
    }

    const MAX_ATTEMPTS: u32 = 3;
    let mut last_err = String::new();

    for attempt in 1..=MAX_ATTEMPTS {
        if attempt > 1 {
            progress.set_label(
                "retrying",
                format!("Повтор NeoForge ({attempt}/{MAX_ATTEMPTS})…"),
            );
            let _ = fs::remove_file(&installer);
            tokio::time::sleep(std::time::Duration::from_secs(3)).await;
        }

        let url = format!(
            "https://maven.neoforged.net/releases/net/neoforged/neoforge/{0}/neoforge-{0}-installer.jar",
            neoforge_version
        );
        if let Err(e) =
            download_to(progress, http, &url, &installer, "NeoForge installer", None, None).await
        {
            last_err = e;
            continue;
        }

        progress.set_label(
            "extracting",
            format!("Устанавливаем NeoForge {neoforge_version}…"),
        );

        let java_clone = java.to_path_buf();
        let installer_clone = installer.clone();
        let root_clone = root.to_path_buf();

        let status = tokio::task::spawn_blocking(move || {
            let mut command = Command::new(&java_clone);
            command
                .arg(format!("-Dhttps.proxyHost={PROXY_HOST}"))
                .arg(format!("-Dhttps.proxyPort={PROXY_PORT}"))
                .arg(format!("-Dhttp.proxyHost={PROXY_HOST}"))
                .arg(format!("-Dhttp.proxyPort={PROXY_PORT}"))
                .arg("-Dhttp.nonProxyHosts=*.mojang.com|*.minecraft.net|sessionserver.mojang.com|launchermeta.mojang.com|piston-meta.mojang.com")
                .arg("-Dhttps.nonProxyHosts=*.mojang.com|*.minecraft.net|sessionserver.mojang.com|launchermeta.mojang.com|piston-meta.mojang.com")
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
                .map_err(|e| format!("Запуск NeoForge installer: {e}"))?;
            let combined = format!(
                "{}\n{}",
                String::from_utf8_lossy(&output.stdout),
                String::from_utf8_lossy(&output.stderr)
            );
            Ok::<(std::process::ExitStatus, String), String>((output.status, combined))
        })
        .await
        .map_err(|e| format!("Ошибка потока NeoForge: {e}"))?
        .map_err(|e: String| e)?;

        let (status, installer_output) = status;
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
                format!("NeoForge installer error ({status})")
            } else {
                format!("NeoForge installer error ({status}):\n{tail}")
            };
            continue;
        }
        if !marker.exists() {
            last_err =
                "NeoForge installer завершился, но профиль не появился".to_string();
            continue;
        }

        return Ok(profile_id);
    }

    Err(last_err)
}

async fn latest_neoforge_21_1(http: &reqwest::Client) -> Result<String, String> {
    let resp =
        http_get_with_retry(http, NEOFORGE_METADATA_URL, "метаданные NeoForge", 5).await?;
    let xml = resp
        .text()
        .await
        .map_err(|e| format!("Чтение NeoForge metadata: {e}"))?;

    xml.split("<version>")
        .filter_map(|part| {
            part.split_once("</version>")
                .map(|(v, _)| v.trim().to_string())
        })
        .filter(|v| v.starts_with(DEFAULT_NEOFORGE_BRANCH))
        .last()
        .ok_or_else(|| "Не удалось найти NeoForge для Minecraft 1.21.1".to_string())
}

// ─── Authlib-injector ──────────────────────────────────────

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

    // Try admin server first
    let admin_url = format!("{ADMIN_BASE}/authlib-injector.jar");
    if let Err(_e) =
        download_to(progress, http, &admin_url, &jar, "authlib-injector", None, None).await
    {
        // Fallback to upstream with SHA-256 verification
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
        if let Some(expected) = &meta.sha256 {
            let actual = compute_sha256_file(&jar)?;
            if actual != expected.trim().to_lowercase() {
                let _ = fs::remove_file(&jar);
                return Err(format!(
                    "SHA-256 authlib-injector не совпал: {actual} != {expected}"
                ));
            }
        }
    }
    Ok(jar)
}

struct InjectorMetaInfo {
    download_url: String,
    sha256: Option<String>,
}

async fn fetch_injector_meta(http: &reqwest::Client) -> Result<InjectorMetaInfo, String> {
    let meta: InjectorMeta = http
        .get(AUTHLIB_INJECTOR_LATEST)
        .send()
        .await
        .map_err(network_error)?
        .error_for_status()
        .map_err(|e| format!("Метаданные authlib-injector: {e}"))?
        .json()
        .await
        .map_err(network_error)?;
    Ok(InjectorMetaInfo {
        download_url: meta.download_url,
        sha256: meta.checksums.and_then(|c| c.sha256),
    })
}

fn compute_sha256_file(path: &Path) -> Result<String, String> {
    let bytes =
        fs::read(path).map_err(|e| format!("Чтение файла для SHA-256: {e}"))?;
    let mut hasher = sha2::Sha256::new();
    hasher.update(&bytes);
    Ok(format!("{:x}", hasher.finalize()))
}

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

// ─── Natives ───────────────────────────────────────────────

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
    let file =
        fs::File::open(zip_path).map_err(|e| format!("Открытие natives jar: {e}"))?;
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

// ─── Classpath ─────────────────────────────────────────────

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
    paths.push(client_jar(root, &vanilla.id));
    join_classpath(&paths)
}

fn library_dedup_key(lib: &Library) -> Option<String> {
    let name = lib.name.as_ref()?;
    let parts: Vec<&str> = name.split(':').collect();
    if parts.len() < 2 {
        return None;
    }
    let classifier = parts.get(3).copied().unwrap_or("");
    Some(format!("{}:{}:{}", parts[0], parts[1], classifier))
}

fn join_classpath(paths: &[PathBuf]) -> String {
    let sep = if cfg!(windows) { ";" } else { ":" };
    paths
        .iter()
        .map(|p| p.to_string_lossy().to_string())
        .collect::<Vec<_>>()
        .join(sep)
}

// ─── Game Args ─────────────────────────────────────────────

fn game_args(
    root: &Path,
    game_dir: &Path,
    version: &VersionJson,
    username: &str,
    uuid: &str,
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
        ("${auth_player_name}", username.to_string()),
        ("${version_name}", version.id.clone()),
        ("${game_directory}", game_dir.to_string_lossy().to_string()),
        ("${assets_root}", assets_dir.to_string_lossy().to_string()),
        ("${assets_index_name}", version.asset_index.id.clone()),
        ("${auth_uuid}", uuid.to_string()),
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

fn argument_value(value: &serde_json::Value) -> Option<String> {
    match value {
        serde_json::Value::String(s) => Some(s.clone()),
        _ => None,
    }
}

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

fn modloader_game_args(loader: &ModLoaderProfile) -> Vec<String> {
    let Some(arguments) = loader.arguments.as_ref() else {
        return Vec::new();
    };
    arguments.game.iter().filter_map(argument_value).collect()
}

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

// ─── Helpers ───────────────────────────────────────────────

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

fn detect_neoforge_version(data_dir: &Path) -> Option<String> {
    let cache_path = data_dir.join("cached-manifest.json");
    let content = fs::read_to_string(cache_path).ok()?;
    let manifest: Manifest = serde_json::from_str(&content).ok()?;
    if manifest.loader.kind == LoaderKind::NeoForge && !manifest.loader.version.is_empty() {
        Some(manifest.loader.version)
    } else {
        None
    }
}

fn load_modloader_profile(root: &Path, profile_id: &str) -> Result<ModLoaderProfile, String> {
    let path = root
        .join("versions")
        .join(profile_id)
        .join(format!("{profile_id}.json"));
    let json = fs::read_to_string(&path)
        .map_err(|e| format!("Чтение профиля NeoForge: {e}"))?;
    serde_json::from_str(&json).map_err(|e| format!("Некорректный профиль NeoForge: {e}"))
}

#[cfg_attr(not(windows), allow(unused_variables))]
fn hide_console(command: &mut Command) {
    #[cfg(windows)]
    {
        command.creation_flags(CREATE_NO_WINDOW);
    }
}

// ─── Download Engine ───────────────────────────────────────

struct DownloadJob {
    url: String,
    path: PathBuf,
    label: String,
    expected_sha1: Option<String>,
    expected_size: Option<u64>,
}

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

    let mut s = stream::iter(jobs.into_iter().map(|job| {
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

    while let Some((label, res)) = s.next().await {
        res?;
        progress.item_done(format!("Скачано: {label}"));
    }
    Ok(())
}

async fn download_to(
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

async fn download_to_counted(
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
    use std::io::{Read as _, Write};

    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }

    let tmp = path.with_extension("download");
    let mut last_err = String::new();

    for attempt in 1..=DOWNLOAD_MAX_ATTEMPTS {
        if attempt > 1 {
            let delay_secs = std::cmp::min(2u64.pow(attempt - 1), 8);
            tokio::time::sleep(std::time::Duration::from_secs(delay_secs)).await;
        }

        let resume_from: u64 = if attempt > 1 {
            fs::metadata(&tmp).map(|m| m.len()).unwrap_or(0)
        } else {
            0
        };

        let mut req = http.get(url);
        if resume_from > 0 {
            req = req.header("Range", format!("bytes={resume_from}-"));
        }
        let resp = match req.send().await {
            Ok(r) => r,
            Err(e) => {
                last_err = format!("Сеть {label}: {e}");
                continue;
            }
        };
        let mut resp = match resp.error_for_status() {
            Ok(r) => r,
            Err(e) => {
                last_err = format!("HTTP {label}: {e}");
                continue;
            }
        };

        let server_accepts_range = resp
            .headers()
            .get("accept-ranges")
            .and_then(|v| v.to_str().ok())
            .map(|v| v.contains("bytes"))
            .unwrap_or(false);
        let is_partial = resp.status() == 206;
        let actual_offset = if is_partial && resume_from > 0 {
            resume_from
        } else if resume_from > 0 && !server_accepts_range {
            0
        } else {
            resume_from
        };

        let total = resp.content_length().map(|cl| cl + actual_offset);
        let mut file = if actual_offset > 0 {
            match fs::OpenOptions::new().append(true).open(&tmp) {
                Ok(f) => f,
                Err(_) => match fs::File::create(&tmp) {
                    Ok(f) => f,
                    Err(e) => return Err(format!("Создание temp файла: {e}")),
                },
            }
        } else {
            match fs::File::create(&tmp) {
                Ok(f) => f,
                Err(e) => return Err(format!("Создание temp файла: {e}")),
            }
        };

        let mut downloaded = actual_offset;
        let mut hasher = Sha1::new();
        if actual_offset > 0 {
            let existing = {
                let mut f = fs::File::open(&tmp)
                    .map_err(|e| format!("Чтение файла для хеша: {e}"))?;
                let mut buf = vec![0u8; actual_offset as usize];
                f.read_exact(&mut buf)
                    .map_err(|e| format!("Чтение файла для хеша: {e}"))?;
                buf
            };
            hasher.update(&existing);
        }

        let started = Instant::now();
        if let DownloadScope::Stage = scope {
            progress.set_label("downloading", format!("Скачиваем {label}"));
            progress.download_tick(downloaded, total, started);
        }

        let mut chunk_err: Option<String> = None;
        loop {
            match tokio::time::timeout(CHUNK_TIMEOUT, resp.chunk()).await {
                Ok(Ok(Some(chunk))) => {
                    hasher.update(&chunk);
                    if let Err(e) = file.write_all(&chunk) {
                        return Err(e.to_string());
                    }
                    downloaded += chunk.len() as u64;
                    match scope {
                        DownloadScope::Stage => {
                            progress.download_tick(downloaded, total, started)
                        }
                        DownloadScope::Item => progress.add_bytes(chunk.len() as u64),
                    }
                }
                Ok(Ok(None)) => break,
                Ok(Err(e)) => {
                    chunk_err = Some(format!("Обрыв скачивания {label}: {e}"));
                    break;
                }
                Err(_elapsed) => {
                    chunk_err = Some(format!(
                        "Таймаут {label}: нет данных {CHUNK_TIMEOUT:?}"
                    ));
                    break;
                }
            }
        }

        if let Some(e) = chunk_err {
            last_err = e;
            continue;
        }

        if let Err(e) = file.flush() {
            return Err(e.to_string());
        }
        drop(file);

        // Size check
        if let Some(expected) = expected_size {
            if downloaded != expected {
                last_err = format!(
                    "Размер {label}: скачано {downloaded}, ожидалось {expected}"
                );
                let _ = fs::remove_file(&tmp);
                continue;
            }
        }

        // SHA-1 check
        if let Some(expected) = expected_sha1 {
            let actual = format!("{:x}", hasher.finalize());
            if !actual.eq_ignore_ascii_case(expected) {
                last_err = format!("SHA-1 {label}: получен {actual}, ожидался {expected}");
                let _ = fs::remove_file(&tmp);
                continue;
            }
        }

        fs::rename(&tmp, path).map_err(|e| {
            format!(
                "Перемещение {} -> {}: {e}",
                tmp.display(),
                path.display()
            )
        })?;
        return Ok(());
    }

    let _ = fs::remove_file(&tmp);
    Err(last_err)
}

fn http_get_with_retry(
    http: &reqwest::Client,
    url: &str,
    label: &str,
    max_attempts: u32,
) -> std::pin::Pin<
    Box<dyn std::future::Future<Output = Result<reqwest::Response, String>> + Send>,
> {
    let http = http.clone();
    let url = url.to_string();
    let label = label.to_string();
    Box::pin(async move {
        let mut last_err = String::new();
        for attempt in 1..=max_attempts {
            if attempt > 1 {
                let delay_secs = std::cmp::min(2u64.pow(attempt - 1), 8);
                tokio::time::sleep(std::time::Duration::from_secs(delay_secs)).await;
            }
            match http.get(&url).send().await {
                Ok(resp) => match resp.error_for_status() {
                    Ok(r) => return Ok(r),
                    Err(e) => {
                        last_err = format!("HTTP {label}: {e}");
                    }
                },
                Err(e) => {
                    last_err = format!("Сеть {label}: {e}");
                }
            }
        }
        Err(last_err)
    })
}

fn network_error(e: reqwest::Error) -> String {
    if e.is_connect() {
        format!("Подключение: {e}")
    } else if e.is_timeout() {
        format!("Таймаут: {e}")
    } else {
        format!("Сеть: {e}")
    }
}

fn build_http_client() -> reqwest::Client {
    let mut builder = reqwest::Client::builder()
        .user_agent(format!(
            "stardust-launcher/{}",
            env!("CARGO_PKG_VERSION")
        ))
        .connect_timeout(std::time::Duration::from_secs(5))
        .timeout(std::time::Duration::from_secs(20));
    if let Ok(proxy) = reqwest::Proxy::all(format!("http://{PROXY_HOST}:{PROXY_PORT}")) {
        builder = builder.proxy(proxy);
    }
    builder.build().unwrap_or_default()
}

// ─── Types ─────────────────────────────────────────────────

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
    game: Vec<serde_json::Value>,
    #[serde(default)]
    jvm: Vec<serde_json::Value>,
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
struct AssetIndexFull {
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
