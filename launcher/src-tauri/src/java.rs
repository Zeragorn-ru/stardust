//! Поиск локальной Java и выбор поставщика runtime для запуска игры.

use std::collections::HashSet;
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::process::Command;

use serde::{Deserialize, Serialize};

use crate::progress::Progress;

pub const JAVA_VERSION: u32 = 21;

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum JavaProvider {
    /// Кэш управляемых runtime → системные установки → скачивание Temurin.
    Auto,
    /// Eclipse Temurin (Adoptium).
    #[default]
    Temurin,
    /// Amazon Corretto.
    Corretto,
    /// Microsoft Build of OpenJDK.
    Microsoft,
    /// Azul Zulu.
    Zulu,
    /// Только Java, найденная в системе.
    System,
    /// Путь из настроек `java_custom_path`.
    Custom,
}

impl JavaProvider {
    fn managed_vendor(self) -> Option<JavaVendor> {
        match self {
            Self::Temurin => Some(JavaVendor::Temurin),
            Self::Corretto => Some(JavaVendor::Corretto),
            Self::Microsoft => Some(JavaVendor::Microsoft),
            Self::Zulu => Some(JavaVendor::Zulu),
            Self::Auto | Self::System | Self::Custom => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum JavaVendor {
    Temurin,
    Corretto,
    Microsoft,
    Zulu,
    Oracle,
}

impl JavaVendor {
    pub fn parse(id: &str) -> Option<Self> {
        match id.trim().to_lowercase().as_str() {
            "temurin" | "adoptium" | "eclipse" => Some(Self::Temurin),
            "corretto" | "amazon" => Some(Self::Corretto),
            "microsoft" | "ms" => Some(Self::Microsoft),
            "zulu" | "azul" => Some(Self::Zulu),
            "oracle" => Some(Self::Oracle),
            _ => None,
        }
    }

    pub fn id(self) -> &'static str {
        match self {
            Self::Temurin => "temurin",
            Self::Corretto => "corretto",
            Self::Microsoft => "microsoft",
            Self::Zulu => "zulu",
            Self::Oracle => "oracle",
        }
    }

    fn name(self) -> &'static str {
        match self {
            Self::Temurin => "Eclipse Temurin",
            Self::Corretto => "Amazon Corretto",
            Self::Microsoft => "Microsoft Build of OpenJDK",
            Self::Zulu => "Azul Zulu",
            Self::Oracle => "Oracle JDK",
        }
    }

    fn managed() -> [Self; 4] {
        [Self::Temurin, Self::Corretto, Self::Microsoft, Self::Zulu]
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JavaVendorInfo {
    pub id: String,
    pub name: String,
    pub label: String,
}

pub fn list_download_vendors() -> Vec<JavaVendorInfo> {
    let platform = current_platform();
    let target = format!("{} {}", platform_name(platform.os), platform.arch);
    vec![
        JavaVendorInfo {
            id: JavaVendor::Temurin.id().to_string(),
            name: "Eclipse Temurin".to_string(),
            label: format!("Adoptium, Java 21 JRE, {target}"),
        },
        JavaVendorInfo {
            id: JavaVendor::Corretto.id().to_string(),
            name: "Amazon Corretto".to_string(),
            label: format!("Amazon, Java 21 JDK, {target}"),
        },
        JavaVendorInfo {
            id: JavaVendor::Microsoft.id().to_string(),
            name: "Microsoft Build of OpenJDK".to_string(),
            label: format!("Microsoft, Java 21 JDK, {target}"),
        },
        JavaVendorInfo {
            id: JavaVendor::Zulu.id().to_string(),
            name: "Azul Zulu".to_string(),
            label: format!("Azul, Java 21 JRE, {target}"),
        },
    ]
}

fn platform_name(os: &str) -> &'static str {
    match os {
        "macos" => "macOS",
        "windows" => "Windows",
        _ => "Linux",
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JavaInstallation {
    pub path: String,
    pub home: String,
    pub version: String,
    pub major: u32,
    pub source: String,
}

struct JavaProbe {
    home: PathBuf,
    exe: PathBuf,
    version: String,
    major: u32,
}

pub fn list_installations(data_dir: &Path) -> Vec<JavaInstallation> {
    collect_installations(data_dir, false)
}

pub fn list_installations_deep(data_dir: &Path) -> Vec<JavaInstallation> {
    collect_installations(data_dir, true)
}

fn collect_installations(data_dir: &Path, deep: bool) -> Vec<JavaInstallation> {
    let mut seen = HashSet::<String>::new();
    let mut out = Vec::new();

    let mut push_home = |home: PathBuf, source: &str| {
        let home = match home
            .canonicalize()
            .or_else(|_| Ok::<_, std::io::Error>(home.clone()))
        {
            Ok(p) => p,
            Err(_) => home,
        };
        let key = home.to_string_lossy().to_lowercase();
        if !seen.insert(key) {
            return;
        }
        if let Some(probe) = probe_java_home(&home) {
            out.push(JavaInstallation {
                path: probe.exe.to_string_lossy().into_owned(),
                home: probe.home.to_string_lossy().into_owned(),
                version: probe.version,
                major: probe.major,
                source: source.to_string(),
            });
        }
    };

    for vendor in JavaVendor::managed() {
        if let Some(runtime_dir) = bundled_runtime_dir(data_dir, vendor) {
            if runtime_dir.exists() {
                push_home(runtime_dir, &format!("{} (лаунчер)", vendor.name()));
            }
        }
    }

    discover_system_installations(&mut push_home);

    if deep {
        discover_deep_installations(&mut push_home);
    }

    out.sort_by(|a, b| {
        b.major
            .cmp(&a.major)
            .then_with(|| a.source.cmp(&b.source))
            .then_with(|| a.path.cmp(&b.path))
    });
    out
}

pub async fn resolve_java(
    provider: JavaProvider,
    custom_path: Option<&str>,
    progress: &Progress,
    http: &reqwest::Client,
    data_dir: &Path,
) -> Result<PathBuf, String> {
    match provider {
        JavaProvider::Custom => {
            let raw = custom_path
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .ok_or_else(|| "Выберите Java в настройках".to_string())?;
            let path = PathBuf::from(raw);
            validate_java_exe(&path)?;
            Ok(launch_exe_from(&path))
        }
        JavaProvider::System => discover_best_java(data_dir)
            .ok_or_else(|| format!("Java {JAVA_VERSION}+ не найдена в системе")),
        JavaProvider::Temurin
        | JavaProvider::Corretto
        | JavaProvider::Microsoft
        | JavaProvider::Zulu => {
            ensure_downloaded_java(provider.managed_vendor().unwrap(), progress, http, data_dir)
                .await
        }
        JavaProvider::Auto => {
            if let Some(path) = bundled_java(data_dir) {
                return Ok(path);
            }
            if let Some(path) = discover_best_java(data_dir) {
                return Ok(path);
            }
            ensure_downloaded_java(JavaVendor::Temurin, progress, http, data_dir).await
        }
    }
}

fn discover_best_java(data_dir: &Path) -> Option<PathBuf> {
    list_installations(data_dir)
        .into_iter()
        .find(|j| j.major >= JAVA_VERSION)
        .map(|j| PathBuf::from(j.path))
        .map(|p| launch_exe_from(&p))
}

fn validate_java_exe(path: &Path) -> Result<(), String> {
    let probe = probe_java_exe(path).ok_or_else(|| {
        format!(
            "Не удалось определить версию Java: {}",
            path.to_string_lossy()
        )
    })?;
    if probe.major < JAVA_VERSION {
        return Err(format!(
            "Нужна Java {JAVA_VERSION}+, найдена {} ({})",
            probe.major, probe.version
        ));
    }
    Ok(())
}

fn launch_exe_from(path: &Path) -> PathBuf {
    if cfg!(windows) && path.file_name().and_then(|n| n.to_str()) == Some("java.exe") {
        let parent = path.parent().unwrap_or(path);
        let javaw = parent.join("javaw.exe");
        if javaw.exists() {
            return javaw;
        }
    }
    path.to_path_buf()
}

fn is_java_home(home: &Path) -> bool {
    version_check_bin(home).exists()
}

/// Ищет JAVA_HOME под каталогом runtime: прямой layout, macOS `Contents/Home`
/// или вложенные папки Temurin (`OpenJDK21U-jre_…/Contents/Home`, `jdk-21/…`).
fn find_java_home_under(root: &Path) -> Option<PathBuf> {
    if is_java_home(root) {
        return Some(root.to_path_buf());
    }
    let mac_home = root.join("Contents").join("Home");
    if is_java_home(&mac_home) {
        return Some(mac_home);
    }
    search_java_home_dirs(root, 8)
}

fn search_java_home_dirs(dir: &Path, max_depth: usize) -> Option<PathBuf> {
    if max_depth == 0 {
        return None;
    }
    let entries = fs::read_dir(dir).ok()?;
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        if should_skip_dir_name(&path) {
            continue;
        }
        if is_java_home(&path) {
            return Some(path);
        }
        let mac_home = path.join("Contents").join("Home");
        if is_java_home(&mac_home) {
            return Some(mac_home);
        }
        if let Some(found) = search_java_home_dirs(&path, max_depth - 1) {
            return Some(found);
        }
    }
    None
}

fn bundled_runtime_dir(data_dir: &Path, vendor: JavaVendor) -> Option<PathBuf> {
    let dir = data_dir.join("runtime").join(vendor.id()).join("java-21");
    if !dir.exists() {
        return None;
    }
    find_java_home_under(&dir)
}

fn bundled_java_for(data_dir: &Path, vendor: JavaVendor) -> Option<PathBuf> {
    let home = bundled_runtime_dir(data_dir, vendor)?;
    let exe = home.join("bin").join(java_bin_name());
    if exe.exists() && probe_java_exe(&exe).is_some_and(|p| p.major >= JAVA_VERSION) {
        Some(exe)
    } else {
        None
    }
}

fn bundled_java(data_dir: &Path) -> Option<PathBuf> {
    JavaVendor::managed()
        .into_iter()
        .find_map(|vendor| bundled_java_for(data_dir, vendor))
}

async fn ensure_downloaded_java(
    vendor: JavaVendor,
    progress: &Progress,
    http: &reqwest::Client,
    data_dir: &Path,
) -> Result<PathBuf, String> {
    if let Some(java) = bundled_java_for(data_dir, vendor) {
        return Ok(java);
    }

    download_java(vendor, progress, http, data_dir).await
}

pub async fn download_java(
    vendor: JavaVendor,
    progress: &Progress,
    http: &reqwest::Client,
    data_dir: &Path,
) -> Result<PathBuf, String> {
    let vendor_name = list_download_vendors()
        .into_iter()
        .find(|v| v.id == vendor.id())
        .map(|v| v.name)
        .unwrap_or_else(|| vendor.id().to_string());

    progress.begin(
        crate::progress::Stage::Java,
        "downloading",
        format!("Скачиваем {vendor_name} Java {JAVA_VERSION}…"),
    );

    let runtime_dir = data_dir.join("runtime").join(vendor.id()).join("java-21");
    if runtime_dir.exists() {
        fs::remove_dir_all(&runtime_dir)
            .map_err(|e| format!("Не удалось очистить runtime Java: {e}"))?;
    }
    fs::create_dir_all(&runtime_dir)
        .map_err(|e| format!("Не удалось создать runtime Java: {e}"))?;

    let url = resolve_download_url(vendor, http).await?;
    let archive_format = archive_format_for_url(&url);

    if archive_format == JavaArchiveFormat::Zip {
        let archive = data_dir
            .join("runtime")
            .join(format!("java-21-{}.zip", vendor.id()));
        crate::minecraft::download_to(
            progress,
            http,
            &url,
            &archive,
            "Java 21 runtime",
            None,
            None,
        )
        .await?;
        validate_archive_header(&archive, JavaArchiveFormat::Zip)?;
        progress.set_label("extracting", "Распаковываем Java 21…");
        extract_java_zip(&archive, &runtime_dir)?;
        let _ = fs::remove_file(&archive);
    } else {
        let archive = data_dir
            .join("runtime")
            .join(format!("java-21-{}.tar.gz", vendor.id()));
        crate::minecraft::download_to(
            progress,
            http,
            &url,
            &archive,
            "Java 21 runtime",
            None,
            None,
        )
        .await?;
        validate_archive_header(&archive, JavaArchiveFormat::TarGz)?;
        progress.set_label("extracting", "Распаковываем Java 21…");
        extract_java_tar_gz(&archive, &runtime_dir)?;
        let _ = fs::remove_file(&archive);
    }

    finalize_extracted_java(&runtime_dir)?;

    bundled_java_for(data_dir, vendor).ok_or_else(|| {
        format!(
            "Java {JAVA_VERSION} скачана, но java не найдена в {}",
            runtime_dir.to_string_lossy()
        )
    })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum JavaArchiveFormat {
    Zip,
    TarGz,
}

fn archive_format_for_url(url: &str) -> JavaArchiveFormat {
    if cfg!(windows) {
        return JavaArchiveFormat::Zip;
    }
    if url.to_lowercase().ends_with(".zip") {
        JavaArchiveFormat::Zip
    } else {
        JavaArchiveFormat::TarGz
    }
}

fn validate_archive_header(path: &Path, format: JavaArchiveFormat) -> Result<(), String> {
    use std::io::Read as _;

    let mut file = fs::File::open(path)
        .map_err(|e| format!("Не удалось открыть скачанную Java для проверки: {e}"))?;
    let mut header = [0u8; 4];
    let read = file
        .read(&mut header)
        .map_err(|e| format!("Не удалось проверить заголовок Java-архива: {e}"))?;
    let valid = match format {
        JavaArchiveFormat::Zip => read >= 4 && header.starts_with(b"PK\x03\x04"),
        JavaArchiveFormat::TarGz => read >= 2 && header[0] == 0x1f && header[1] == 0x8b,
    };
    if valid {
        return Ok(());
    }

    let _ = fs::remove_file(path);
    Err(match format {
        JavaArchiveFormat::Zip => {
            "Скачанная Java не является zip-архивом. Проверьте прокси или сеть.".to_string()
        }
        JavaArchiveFormat::TarGz => {
            "Скачанная Java не является gzip-архивом. Проверьте прокси или сеть.".to_string()
        }
    })
}

struct Platform {
    os: &'static str,
    arch: &'static str,
}

fn current_platform() -> Platform {
    if cfg!(target_os = "macos") {
        Platform {
            os: "macos",
            arch: if cfg!(target_arch = "aarch64") {
                "aarch64"
            } else {
                "x64"
            },
        }
    } else if cfg!(target_os = "linux") {
        Platform {
            os: "linux",
            arch: "x64",
        }
    } else {
        Platform {
            os: "windows",
            arch: "x64",
        }
    }
}

async fn resolve_download_url(
    vendor: JavaVendor,
    http: &reqwest::Client,
) -> Result<String, String> {
    match vendor {
        JavaVendor::Temurin => Ok(temurin_url()),
        JavaVendor::Corretto => Ok(corretto_url()),
        JavaVendor::Microsoft => Ok(microsoft_url()),
        JavaVendor::Oracle => Ok(oracle_url()),
        JavaVendor::Zulu => resolve_zulu_url(http).await,
    }
}

fn temurin_url() -> String {
    let (os, arch) = if cfg!(target_os = "macos") {
        (
            "mac",
            if cfg!(target_arch = "aarch64") {
                "aarch64"
            } else {
                "x64"
            },
        )
    } else if cfg!(target_os = "linux") {
        ("linux", "x64")
    } else {
        ("windows", "x64")
    };
    format!(
        "https://api.adoptium.net/v3/binary/latest/{JAVA_VERSION}/ga/{os}/{arch}/jre/hotspot/normal/eclipse"
    )
}

fn corretto_url() -> String {
    let platform = current_platform();
    match (platform.os, platform.arch) {
        ("macos", "aarch64") => {
            "https://corretto.aws/downloads/latest/amazon-corretto-21-aarch64-macos-jdk.tar.gz"
        }
        ("macos", "x64") => {
            "https://corretto.aws/downloads/latest/amazon-corretto-21-x64-macos-jdk.tar.gz"
        }
        ("linux", "x64") => {
            "https://corretto.aws/downloads/latest/amazon-corretto-21-x64-linux-jdk.tar.gz"
        }
        ("windows", "x64") => {
            "https://corretto.aws/downloads/latest/amazon-corretto-21-x64-windows-jdk.zip"
        }
        _ => "https://corretto.aws/downloads/latest/amazon-corretto-21-x64-linux-jdk.tar.gz",
    }
    .to_string()
}

fn microsoft_url() -> String {
    let platform = current_platform();
    match (platform.os, platform.arch) {
        ("macos", "aarch64") => {
            "https://aka.ms/download-jdk/microsoft-jdk-21.0.7-macOS-aarch64.tar.gz"
        }
        ("macos", "x64") => "https://aka.ms/download-jdk/microsoft-jdk-21.0.7-macOS-x64.tar.gz",
        ("linux", "x64") => "https://aka.ms/download-jdk/microsoft-jdk-21.0.7-linux-x64.tar.gz",
        ("windows", "x64") => "https://aka.ms/download-jdk/microsoft-jdk-21.0.7-windows-x64.zip",
        _ => "https://aka.ms/download-jdk/microsoft-jdk-21.0.7-linux-x64.tar.gz",
    }
    .to_string()
}

fn oracle_url() -> String {
    let platform = current_platform();
    match (platform.os, platform.arch) {
        ("macos", "aarch64") => {
            "https://download.oracle.com/java/21/latest/jdk-21_macos-aarch64_bin.tar.gz"
        }
        ("macos", "x64") => {
            "https://download.oracle.com/java/21/latest/jdk-21_macos-x64_bin.tar.gz"
        }
        ("linux", "x64") => {
            "https://download.oracle.com/java/21/latest/jdk-21_linux-x64_bin.tar.gz"
        }
        ("windows", "x64") => {
            "https://download.oracle.com/java/21/latest/jdk-21_windows-x64_bin.zip"
        }
        _ => "https://download.oracle.com/java/21/latest/jdk-21_linux-x64_bin.tar.gz",
    }
    .to_string()
}

#[derive(Debug, Deserialize)]
struct ZuluPackage {
    download_url: String,
}

async fn resolve_zulu_url(http: &reqwest::Client) -> Result<String, String> {
    let platform = current_platform();
    let (os, arch) = match (platform.os, platform.arch) {
        ("macos", "aarch64") => ("macos", "arm"),
        ("macos", "x64") => ("macos", "x86_64"),
        ("linux", "x64") => ("linux", "x86_64"),
        ("windows", "x64") => ("windows", "x86_64"),
        _ => ("linux", "x86_64"),
    };

    let url = format!(
        "https://api.azul.com/metadata/v1/zulu/packages/?java_version={JAVA_VERSION}&os={os}&arch={arch}&java_package_type=jre&availability_types=ca&release_status=ga&latest=true&distribution=zulu"
    );

    let packages: Vec<ZuluPackage> = http
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("Не удалось запросить Azul Zulu API: {e}"))?
        .error_for_status()
        .map_err(|e| format!("Azul Zulu API: {e}"))?
        .json()
        .await
        .map_err(|e| format!("Не удалось разобрать ответ Azul Zulu API: {e}"))?;

    packages
        .into_iter()
        .next()
        .map(|p| p.download_url)
        .ok_or_else(|| "Azul Zulu: пакет Java 21 не найден".to_string())
}

fn java_bin_name() -> &'static str {
    if cfg!(windows) {
        "javaw.exe"
    } else {
        "java"
    }
}

fn version_check_bin(home: &Path) -> PathBuf {
    home.join("bin")
        .join(if cfg!(windows) { "java.exe" } else { "java" })
}

fn probe_java_home(home: &Path) -> Option<JavaProbe> {
    probe_java_exe(&version_check_bin(home)).map(|mut probe| {
        probe.home = home.to_path_buf();
        probe
    })
}

fn probe_java_exe(exe: &Path) -> Option<JavaProbe> {
    if !exe.exists() {
        return None;
    }
    let mut command = Command::new(exe);
    command.arg("-version");
    hide_console(&mut command);
    let output = command.output().ok()?;
    let text = String::from_utf8_lossy(&output.stderr);
    let (version, major) = parse_java_version(&text)?;
    if major < JAVA_VERSION {
        return None;
    }
    let home = exe
        .parent()
        .and_then(|bin| bin.parent())
        .map(Path::to_path_buf)
        .unwrap_or_else(|| exe.parent().unwrap_or(exe).to_path_buf());
    Some(JavaProbe {
        home,
        exe: exe.to_path_buf(),
        version,
        major,
    })
}

fn parse_java_version(text: &str) -> Option<(String, u32)> {
    let marker = "version \"";
    let start = text.find(marker)? + marker.len();
    let rest = &text[start..];
    let version = rest.split('"').next()?.to_string();
    let major = parse_java_major(&version)?;
    Some((version, major))
}

fn parse_java_major(version: &str) -> Option<u32> {
    let first = version.split('.').next()?;
    if first == "1" {
        version.split('.').nth(1)?.parse().ok()
    } else {
        first.parse().ok()
    }
}

fn discover_system_installations(mut push_home: impl FnMut(PathBuf, &str)) {
    if let Ok(home) = std::env::var("JAVA_HOME") {
        push_home(PathBuf::from(home), "JAVA_HOME");
    }

    #[cfg(target_os = "macos")]
    discover_macos(&mut push_home);

    #[cfg(target_os = "linux")]
    discover_linux(&mut push_home);

    #[cfg(windows)]
    discover_windows(&mut push_home);

    if let Some(path) = which_java() {
        if let Some(parent) = path.parent().and_then(|p| p.parent()) {
            push_home(parent.to_path_buf(), "PATH");
        }
    }
}

fn discover_deep_installations(push_home: &mut impl FnMut(PathBuf, &str)) {
    for root in deep_search_roots() {
        deep_search_dir(&root, 0, 6, push_home);
    }
}

fn deep_search_roots() -> Vec<PathBuf> {
    #[cfg(target_os = "macos")]
    {
        let mut roots = vec![
            PathBuf::from("/Applications"),
            PathBuf::from("/Library"),
            PathBuf::from("/opt"),
            PathBuf::from("/usr/local"),
        ];
        if let Ok(home) = std::env::var("HOME") {
            roots.push(PathBuf::from(home).join("Applications"));
        }
        roots
    }
    #[cfg(windows)]
    {
        vec![
            PathBuf::from(r"C:\Program Files"),
            PathBuf::from(r"C:\Program Files (x86)"),
        ]
    }
    #[cfg(target_os = "linux")]
    {
        let mut roots = vec![PathBuf::from("/usr"), PathBuf::from("/opt")];
        if let Ok(home) = std::env::var("HOME") {
            roots.push(PathBuf::from(home));
        }
        roots
    }
    #[cfg(not(any(target_os = "macos", windows, target_os = "linux")))]
    {
        Vec::new()
    }
}

fn deep_search_dir(
    dir: &Path,
    depth: usize,
    max_depth: usize,
    push_home: &mut impl FnMut(PathBuf, &str),
) {
    if depth > max_depth {
        return;
    }
    let entries = match fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(_) => return,
    };

    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        if should_skip_dir_name(&path) {
            continue;
        }

        if is_java_home(&path) {
            push_home(path.clone(), "Глубокий поиск");
            continue;
        }
        let mac_home = path.join("Contents").join("Home");
        if is_java_home(&mac_home) {
            push_home(mac_home, "Глубокий поиск");
            continue;
        }

        if looks_like_java_dir(&path) {
            if let Some(found) = find_java_home_under(&path) {
                push_home(found, "Глубокий поиск");
                continue;
            }
        }

        deep_search_dir(&path, depth + 1, max_depth, push_home);
    }
}

fn looks_like_java_dir(path: &Path) -> bool {
    let name = path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or_default()
        .to_lowercase();
    name.contains("java")
        || name.contains("jdk")
        || name.contains("jre")
        || name.contains("corretto")
        || name.contains("zulu")
        || name.contains("temurin")
        || name.contains("openjdk")
        || name.ends_with(".jdk")
}

fn should_skip_dir_name(path: &Path) -> bool {
    let name = path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or_default()
        .to_lowercase();
    matches!(
        name.as_str(),
        "node_modules"
            | ".git"
            | ".svn"
            | ".hg"
            | "target"
            | "build"
            | "dist"
            | ".cache"
            | "cache"
            | "caches"
            | ".npm"
            | ".cargo"
            | ".rustup"
            | ".gradle"
            | ".m2"
            | "library"
            | "libraries"
            | "containers"
            | "volumes"
            | "proc"
            | "sys"
            | "dev"
            | "tmp"
            | "temp"
    ) || name.starts_with('.')
}

#[cfg(target_os = "macos")]
fn discover_macos(push_home: &mut impl FnMut(PathBuf, &str)) {
    if let Ok(output) = Command::new("/usr/libexec/java_home")
        .arg("-v")
        .arg("21")
        .output()
    {
        let home = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if output.status.success() && home.starts_with('/') {
            push_home(PathBuf::from(home), "macOS java_home (21)");
        }
    }

    if let Ok(output) = Command::new("/usr/libexec/java_home").arg("-V").output() {
        let text = String::from_utf8_lossy(&output.stderr);
        for line in text.lines().skip(1) {
            if let Some(home) = line.split_whitespace().rfind(|t| t.starts_with('/')) {
                push_home(PathBuf::from(home.trim_matches('"')), "macOS java_home");
            }
        }
    }

    for root in macos_jvm_roots() {
        let Ok(entries) = fs::read_dir(&root) else {
            continue;
        };
        for entry in entries.flatten() {
            let bundle = entry.path();
            let home = bundle.join("Contents/Home");
            if home.is_dir() {
                push_home(home, "macOS JVM");
            } else if let Some(found) = find_java_home_under(&bundle) {
                push_home(found, "macOS JVM");
            }
        }
    }

    for path in [
        "/opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home",
        "/opt/homebrew/opt/openjdk/libexec/openjdk.jdk/Contents/Home",
        "/usr/local/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home",
        "/usr/local/opt/openjdk/libexec/openjdk.jdk/Contents/Home",
    ] {
        push_home(PathBuf::from(path), "Homebrew");
    }
}

#[cfg(target_os = "macos")]
fn macos_jvm_roots() -> Vec<PathBuf> {
    let mut roots = vec![PathBuf::from("/Library/Java/JavaVirtualMachines")];
    if let Ok(home) = std::env::var("HOME") {
        roots.push(PathBuf::from(home).join("Library/Java/JavaVirtualMachines"));
    }
    roots
}

#[cfg(target_os = "linux")]
fn discover_linux(push_home: &mut impl FnMut(PathBuf, &str)) {
    for root in ["/usr/lib/jvm", "/usr/java"] {
        let Ok(entries) = fs::read_dir(root) else {
            continue;
        };
        for entry in entries.flatten() {
            push_home(entry.path(), "Linux JVM");
        }
    }

    if let Ok(output) = Command::new("update-alternatives")
        .arg("--list")
        .arg("java")
        .output()
    {
        let text = String::from_utf8_lossy(&output.stdout);
        for line in text.lines() {
            let path = PathBuf::from(line.trim());
            if let Some(parent) = path.parent().and_then(|p| p.parent()) {
                push_home(parent.to_path_buf(), "update-alternatives");
            }
        }
    }
}

#[cfg(windows)]
fn discover_windows(push_home: &mut impl FnMut(PathBuf, &str)) {
    for root in [
        r"C:\Program Files\Java",
        r"C:\Program Files\Eclipse Adoptium",
        r"C:\Program Files\Microsoft",
        r"C:\Program Files\Amazon Corretto",
        r"C:\Program Files\Zulu",
    ] {
        let Ok(entries) = fs::read_dir(root) else {
            continue;
        };
        for entry in entries.flatten() {
            push_home(entry.path(), "Program Files");
        }
    }
}

fn which_java() -> Option<PathBuf> {
    let cmd = if cfg!(windows) { "where" } else { "which" };
    let mut command = Command::new(cmd);
    command.arg("java");
    hide_console(&mut command);
    let output = command.output().ok()?;
    if !output.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&output.stdout);
    let line = text.lines().next()?.trim();
    if line.is_empty() {
        None
    } else {
        Some(PathBuf::from(line))
    }
}

#[cfg_attr(not(windows), allow(unused_variables))]
fn hide_console(command: &mut Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
}

fn finalize_extracted_java(runtime_dir: &Path) -> Result<(), String> {
    let home = find_java_home_under(runtime_dir).ok_or_else(|| {
        format!(
            "После распаковки JAVA_HOME не найден в {}",
            runtime_dir.to_string_lossy()
        )
    })?;
    #[cfg(windows)]
    let _ = &home;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let java_bin = home.join("bin").join("java");
        if java_bin.exists() {
            let mut perms = fs::metadata(&java_bin)
                .map_err(|e| format!("Не удалось прочитать права java: {e}"))?
                .permissions();
            perms.set_mode(perms.mode() | 0o111);
            fs::set_permissions(&java_bin, perms)
                .map_err(|e| format!("Не удалось выставить права java: {e}"))?;
        }
    }

    Ok(())
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
        let stripped = strip_archive_top_level(&name);
        if stripped.is_empty() {
            continue;
        }
        if Path::new(stripped)
            .components()
            .any(|c| matches!(c, Component::ParentDir))
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
        #[cfg(unix)]
        {
            if let Some(mode) = file.unix_mode() {
                use std::os::unix::fs::PermissionsExt;
                if let Ok(mut perms) = out_file.metadata().map(|m| m.permissions()) {
                    perms.set_mode(mode);
                    let _ = out_file.set_permissions(perms);
                }
            }
        }
    }
    Ok(())
}

/// macOS JDK bundles ship code-signing metadata and xattrs that are not needed
/// to run `java` and often fail when extracted outside a `.app` bundle.
fn should_skip_tar_path(path: &str) -> bool {
    let normalized = path.replace('\\', "/");
    if normalized.starts_with("__MACOSX/") {
        return true;
    }
    let file_name = Path::new(path)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or_default();
    if file_name == ".DS_Store" || file_name.starts_with("._") {
        return true;
    }
    normalized
        .split('/')
        .any(|part| part == "_CodeSignature" || part == "CodeResources")
}

fn drain_tar_entry(entry: &mut tar::Entry<'_, impl std::io::Read>) -> Result<(), String> {
    std::io::copy(entry, &mut std::io::sink()).map_err(|e| e.to_string())?;
    Ok(())
}

fn extract_tar_entry(
    entry: &mut tar::Entry<'_, impl std::io::Read>,
    out: &Path,
    stripped: &str,
) -> Result<(), String> {
    let entry_type = entry.header().entry_type();
    if entry_type.is_dir() {
        fs::create_dir_all(out).map_err(|e| e.to_string())?;
        drain_tar_entry(entry)?;
        return Ok(());
    }

    if should_skip_tar_path(stripped) {
        drain_tar_entry(entry)?;
        return Ok(());
    }

    if entry_type.is_symlink() {
        #[cfg(unix)]
        {
            use std::os::unix::fs::symlink;
            let link = entry
                .link_name()
                .map_err(|e| e.to_string())?
                .ok_or_else(|| format!("Симлинк без цели: {stripped}"))?;
            if let Some(parent) = out.parent() {
                fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            }
            let _ = fs::remove_file(out);
            symlink(&link, out).map_err(|e| {
                format!(
                    "Не удалось создать симлинк {} -> {}: {e}",
                    out.display(),
                    link.display()
                )
            })?;
            drain_tar_entry(entry)?;
            return Ok(());
        }
        #[cfg(not(unix))]
        {
            drain_tar_entry(entry)?;
            return Ok(());
        }
    }

    if !(entry_type.is_file() || entry_type.is_hard_link()) {
        drain_tar_entry(entry)?;
        return Ok(());
    }

    if let Some(parent) = out.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    #[cfg(unix)]
    let mode = entry.header().mode().ok();
    let mut out_file = fs::File::create(out).map_err(|e| e.to_string())?;
    std::io::copy(entry, &mut out_file).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if let Some(mode) = mode {
            if let Ok(mut perms) = out_file.metadata().map(|m| m.permissions()) {
                perms.set_mode(mode);
                let _ = out_file.set_permissions(perms);
            }
        }
    }
    Ok(())
}

fn extract_java_tar_gz(archive: &Path, target: &Path) -> Result<(), String> {
    let file =
        fs::File::open(archive).map_err(|e| format!("Не удалось открыть Java archive: {e}"))?;
    let dec = flate2::read::GzDecoder::new(file);
    let mut archive = tar::Archive::new(dec);
    archive.set_unpack_xattrs(false);
    archive.set_preserve_permissions(false);
    archive.set_preserve_ownerships(false);

    for entry in archive
        .entries()
        .map_err(|e| format!("Ошибка распаковки Java tar.gz: {e}"))?
    {
        let mut entry = entry.map_err(|e| format!("Ошибка распаковки Java tar.gz: {e}"))?;
        entry.set_unpack_xattrs(false);
        entry.set_preserve_permissions(false);

        let path = entry
            .path()
            .map_err(|e| format!("Ошибка распаковки Java tar.gz: {e}"))?
            .into_owned();
        let name = path.to_string_lossy().replace('\\', "/");
        if name.is_empty() {
            drain_tar_entry(&mut entry)?;
            continue;
        }
        let stripped = strip_archive_top_level(&name);
        if stripped.is_empty() {
            drain_tar_entry(&mut entry)?;
            continue;
        }
        if should_skip_tar_path(stripped) {
            drain_tar_entry(&mut entry)?;
            continue;
        }
        if Path::new(stripped)
            .components()
            .any(|c| matches!(c, Component::ParentDir))
        {
            return Err(format!(
                "Небезопасный путь в tar: {name} (попытка выхода за пределы {})",
                target.display()
            ));
        }

        let out = target.join(stripped);
        if let Err(e) = extract_tar_entry(&mut entry, &out, stripped) {
            if should_skip_tar_path(stripped) {
                drain_tar_entry(&mut entry)?;
                continue;
            }
            return Err(format!(
                "Ошибка распаковки Java tar.gz: failed to unpack `{}`: {e}",
                out.display()
            ));
        }
    }
    Ok(())
}

fn strip_archive_top_level(name: &str) -> &str {
    name.split_once('/').map(|(_, rest)| rest).unwrap_or(name)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn parse_java_major_handles_modern_and_legacy() {
        assert_eq!(parse_java_major("21.0.11"), Some(21));
        assert_eq!(parse_java_major("1.8.0_402"), Some(8));
    }

    #[test]
    fn parse_java_version_old_style() {
        assert_eq!(
            parse_java_version("java version \"1.8.0_301\""),
            Some(("1.8.0_301".to_string(), 8))
        );
    }

    #[test]
    fn parse_java_version_new_style() {
        assert_eq!(
            parse_java_version("openjdk version \"21.0.1\" 2024-04-16"),
            Some(("21.0.1".to_string(), 21))
        );
    }

    #[test]
    fn parse_java_version_empty() {
        assert_eq!(parse_java_version(""), None);
    }

    #[test]
    fn parse_java_version_no_version() {
        assert_eq!(parse_java_version("some random text"), None);
    }

    #[test]
    fn find_java_home_under_macos_temurin_layout() {
        let dir = std::env::temp_dir().join("stardust_test_java_home_mac");
        let _ = fs::remove_dir_all(&dir);
        let jre_root = dir.join("OpenJDK21U-jre_test");
        let home = jre_root.join("Contents").join("Home");
        fs::create_dir_all(home.join("bin")).unwrap();
        fs::write(home.join("bin").join("java"), b"").unwrap();

        assert_eq!(find_java_home_under(&dir), Some(home));

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn find_java_home_under_linux_temurin_layout() {
        let dir = std::env::temp_dir().join("stardust_test_java_home_linux");
        let _ = fs::remove_dir_all(&dir);
        let home = dir.join("jdk-21.0.11+10-jre");
        fs::create_dir_all(home.join("bin")).unwrap();
        fs::write(home.join("bin").join("java"), b"").unwrap();

        assert_eq!(find_java_home_under(&dir), Some(home));

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn extract_java_zip_rejects_slip() {
        let dir = std::env::temp_dir().join("stardust_test_zip_slip");
        let _ = fs::create_dir_all(&dir);
        let target = dir.join("target");
        let _ = fs::create_dir_all(&target);

        let zip_path = dir.join("malicious.zip");
        {
            let file = fs::File::create(&zip_path).unwrap();
            let mut zip = zip::ZipWriter::new(file);
            let options = zip::write::SimpleFileOptions::default()
                .compression_method(zip::CompressionMethod::Stored);
            zip.start_file("jdk/bin/../../etc/passwd", options).unwrap();
            zip.write_all(b"malicious").unwrap();
            zip.finish().unwrap();
        }

        let result = extract_java_zip(&zip_path, &target);
        assert!(result.is_err());
        let err = result.unwrap_err();
        assert!(err.contains("Небезопасный путь"), "Error was: {err}");

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn extract_java_zip_accepts_valid() {
        let dir = std::env::temp_dir().join("stardust_test_zip_valid");
        let _ = fs::create_dir_all(&dir);
        let target = dir.join("target");
        let _ = fs::create_dir_all(&target);

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

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn should_skip_tar_path_ignores_codesign_and_metadata() {
        assert!(should_skip_tar_path(
            "jdk-21/Contents/_CodeSignature/CodeResources"
        ));
        assert!(should_skip_tar_path("__MACOSX/jdk-21/._java"));
        assert!(should_skip_tar_path("jdk-21/Contents/Home/.DS_Store"));
        assert!(!should_skip_tar_path("jdk-21/Contents/Home/bin/java"));
    }

    #[test]
    fn extract_java_tar_gz_skips_codesign_and_finds_java_home() {
        let dir = std::env::temp_dir().join("stardust_test_tar_codesign");
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let target = dir.join("target");
        fs::create_dir_all(&target).unwrap();

        let archive_path = dir.join("test.tar.gz");
        {
            let file = fs::File::create(&archive_path).unwrap();
            let enc = flate2::write::GzEncoder::new(file, flate2::Compression::default());
            let mut builder = tar::Builder::new(enc);

            let mut header = tar::Header::new_gnu();
            header
                .set_path("jdk-21.0.11+10-jre/Contents/Home/bin/java")
                .unwrap();
            header.set_size(4);
            header.set_mode(0o755);
            header.set_cksum();
            builder.append(&header, &b"java"[..]).unwrap();

            let mut sig_header = tar::Header::new_gnu();
            sig_header
                .set_path("jdk-21.0.11+10-jre/Contents/_CodeSignature/CodeResources")
                .unwrap();
            sig_header.set_size(8);
            sig_header.set_cksum();
            builder.append(&sig_header, &b"bad data"[..]).unwrap();

            builder.into_inner().unwrap().finish().unwrap();
        }

        extract_java_tar_gz(&archive_path, &target).unwrap();
        let home = target.join("Contents").join("Home");
        assert!(home.join("bin").join("java").exists());
        assert!(!target.join("Contents").join("_CodeSignature").exists());
        assert_eq!(find_java_home_under(&target), Some(home));

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn strip_archive_top_level_removes_prefix() {
        assert_eq!(strip_archive_top_level("jdk-21/bin/java"), "bin/java");
        assert_eq!(strip_archive_top_level("java"), "java");
    }
}
