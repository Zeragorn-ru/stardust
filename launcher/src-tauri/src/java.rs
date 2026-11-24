//! Поиск локальной Java и выбор поставщика runtime для запуска игры.

use std::collections::HashSet;
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::process::Command;

use serde::{Deserialize, Serialize};

use crate::progress::Progress;

pub const JAVA_VERSION: u32 = 21;

/// CVE-2026-114938 (Oracle Critical Security Patch Update от 17.11.2026,
/// компонент `hotspot/compiler`, CVSS 8.1): RCE в компиляторе затронула
/// 17.0.21, 21.0.13, 25.0.5 и 27.0.1. Oracle перевыпустил сборки с
/// четвёртой цифрой (`21.0.13.1`), Corretto/Zulu уже её раздают, а Adoptium
/// на момент правки отдаёт ещё уязвимый `21.0.13+9`.
///
/// Порог — первая ИСПРАВЛЕННАЯ версия; всё, что меньше, считается
/// уязвимым. Сравнение компонентное: `21.0.13` < `21.0.13.1`, а
/// `21.0.14` уже больше.
fn fixed_java_version(major: u32) -> Option<[u32; 4]> {
    match major {
        17 => Some([17, 0, 21, 1]),
        21 => Some([21, 0, 13, 1]),
        25 => Some([25, 0, 5, 1]),
        27 => Some([27, 0, 1, 1]),
        // 8/11 и не-LTS ветки в бюллетене по этому CVE не фигурируют.
        _ => None,
    }
}

/// Разбирает `21.0.13.1` / `21.0.13` / `17.0.21` в компоненты для сравнения.
///
/// Хвост после `+` — это номер билда (`21.0.13+9`), а не компонент версии:
/// он не должен превращаться в четвёртую цифру и «обгонять» выпуск фикса.
fn version_components(version: &str) -> Vec<u32> {
    version
        .split('+')
        .next()
        .unwrap_or(version)
        .split(|c: char| !c.is_ascii_digit())
        .filter(|part| !part.is_empty())
        .filter_map(|part| part.parse::<u32>().ok())
        .collect()
}

/// Компонентное сравнение: `21.0.13` < `21.0.13.1` < `21.0.14`.
fn version_less(older: &str, newer: &str) -> bool {
    let mut a = [0u32; 4];
    let mut b = [0u32; 4];
    for (slot, value) in a.iter_mut().zip(version_components(older)) {
        *slot = value;
    }
    for (slot, value) in b.iter_mut().zip(version_components(newer)) {
        *slot = value;
    }
    a < b
}

/// Уязвима ли эта сборка Java к CVE-2026-114938.
///
/// Версия без патча (`None`) не проверяется: неизвестную сборку страшнее
/// объявить безопасной, но и блокировать игру из-за неё нельзя — поэтому
/// её считаем уязвимой. Пользователь увидит предупреждение и сможет
/// обновиться.
pub(crate) fn is_vulnerable_java(version: &str, major: u32) -> bool {
    let Some(fixed) = fixed_java_version(major) else {
        return false;
    };
    let parts = version_components(version);
    if parts.is_empty() {
        return true;
    }
    // Дополняем нулями до фиксированной длины: `21.0.13` == [21,0,13,0].
    let mut current = [0u32; 4];
    for (slot, value) in current.iter_mut().zip(parts) {
        *slot = value;
    }
    // Баг появился в 17.0.6: в более ранних сборках Base64-интринсика в
    // таком виде просто нет (пишет Calif.io в разборе Java4Shell).
    if major == 17 && current < [17, 0, 6, 0] {
        return false;
    }
    current < fixed
}

/// Достигает ли этот CPU уязвимого пути Base64-декодера.
///
/// Java4Shell живёт в hand-rolled ассемблере под AVX-512 VBMI: на ARM64 и
/// на x86-64 без AVX-512 VBMI (нужны AVX-512F, AVX-512BW, VBMI и BMI2)
/// этот код не исполняется. Проверяем CPU, а не его модель — AVX-512 может
/// быть выключен в BIOS, и тогда эксплойт тоже не срабатывает.
pub(crate) fn cpu_reaches_vulnerable_base64() -> bool {
    #[cfg(any(target_arch = "x86", target_arch = "x86_64"))]
    {
        is_x86_feature_detected!("avx512f")
            && is_x86_feature_detected!("avx512bw")
            && is_x86_feature_detected!("avx512vbmi")
            && is_x86_feature_detected!("bmi2")
    }
    #[cfg(not(any(target_arch = "x86", target_arch = "x86_64")))]
    {
        false
    }
}

/// Человекочитаемое объяснение CPU-гейта для UI и логов.
pub(crate) fn cpu_exposure_summary() -> &'static str {
    if cpu_reaches_vulnerable_base64() {
        "процессор исполняет уязвимый AVX-512 VBMI путь Base64-декодера"
    } else {
        "на этом процессоре уязвимый AVX-512 VBMI путь недостижим (нужен x86-64 с AVX-512 VBMI и BMI2)"
    }
}

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

    pub(crate) fn name(self) -> &'static str {
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
    /// Сборка содержит незакрытую CVE-2026-114938 (см. `is_vulnerable_java`).
    pub vulnerable: bool,
    /// Уязвимый путь реально достижим на этом CPU (AVX-512 VBMI).
    /// `vulnerable && !cpu_exposed` — обновиться стоит, но эксплойт не сработает.
    pub cpu_exposed: bool,
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
            Ok(p) => crate::paths::strip_extended_prefix(p),
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
                version: probe.version.clone(),
                major: probe.major,
                source: source.to_string(),
                vulnerable: is_vulnerable_java(&probe.version, probe.major),
                cpu_exposed: cpu_reaches_vulnerable_base64(),
            });
        }
    };

    for vendor in JavaVendor::managed() {
        let base = data_dir.join("runtime").join(vendor.id());
        if let Ok(entries) = fs::read_dir(base) {
            for entry in entries.flatten() {
                let name = entry.file_name();
                let Some(major) = name.to_str().and_then(|s| s.strip_prefix("java-")).and_then(|s| s.parse::<u32>().ok()) else { continue };
                if let Some(home) = bundled_runtime_dir(data_dir, vendor, major) {
                    push_home(home, &format!("{} (лаунчер)", vendor.name()));
                }
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
            // Внутри одной мажорной версии безопасная сборка идёт первой:
            // иначе discover_best_java возьмёт уязвимый рантайм, хотя рядом
            // лежит уже пропатченный (CVE-2026-114938).
            .then_with(|| a.vulnerable.cmp(&b.vulnerable))
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
    required_major: u32,
) -> Result<PathBuf, String> {
    tracing::info!(
        "[java] resolve: provider={:?}, custom_path={}",
        provider,
        custom_path.unwrap_or("<none>")
    );
    match provider {
        JavaProvider::Custom => {
            let raw = custom_path
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .ok_or_else(|| "Выберите Java в настройках".to_string())?;
            let path = normalize_java_path(Path::new(raw));
            tracing::debug!("[java] custom path normalized: {}", path.display());
            validate_java_exe(&path, required_major)?;
            Ok(launch_exe_from(&path))
        }
        JavaProvider::System => discover_best_java(data_dir, required_major)
            .ok_or_else(|| format!("Java {required_major}+ не найдена в системе")),
        JavaProvider::Temurin
        | JavaProvider::Corretto
        | JavaProvider::Microsoft
        | JavaProvider::Zulu => {
            ensure_downloaded_java(provider.managed_vendor().unwrap(), progress, http, data_dir, required_major)
                .await
        }
        JavaProvider::Auto => {
            if let Some((vendor, path, vulnerable)) = bundled_java_entry(data_dir, required_major) {
                if !vulnerable {
                    return Ok(path);
                }
                // Единственный кэшированный рантайм уязвим (CVE-2026-114938):
                // пробуем обновить его у вендора, при неудаче — играем как есть.
                tracing::warn!(
                    "[java] кэш {} содержит CVE-2026-114938 — проверяем обновление",
                    vendor.name()
                );
                return ensure_downloaded_java(vendor, progress, http, data_dir, required_major)
                    .await
                    .or(Ok(path));
            }
            if let Some(path) = discover_best_java(data_dir, required_major) {
                return Ok(path);
            }
            ensure_downloaded_java(JavaVendor::Temurin, progress, http, data_dir, required_major).await
        }
    }
}

fn discover_best_java(data_dir: &Path, required_major: u32) -> Option<PathBuf> {
    list_installations(data_dir)
        .into_iter()
        .find(|j| j.major >= required_major)
        .map(|j| PathBuf::from(j.path))
        .map(|p| launch_exe_from(&p))
}

/// Версия и мажор выбранной Java — для проверки на CVE перед запуском.
pub(crate) fn java_version(path: &Path) -> Result<(String, u32), String> {
    probe_java_exe(&console_java_exe(path))
        .map(|p| (p.version, p.major))
        .ok_or_else(|| format!("Не удалось определить версию Java: {}", path.display()))
}

fn validate_java_exe(path: &Path, required_major: u32) -> Result<(), String> {
    let probe = probe_java_exe(&console_java_exe(path)).ok_or_else(|| {
        format!(
            "Не удалось определить версию Java: {}",
            path.to_string_lossy()
        )
    })?;
    if probe.major < required_major {
        return Err(format!(
            "Нужна Java {required_major}+, найдена {} ({})",
            probe.major, probe.version
        ));
    }
    Ok(())
}

fn normalize_java_path(path: &Path) -> PathBuf {
    if path.is_dir() {
        let unix = path.join("bin").join("java");
        if unix.exists() {
            return unix;
        }
        let windows = path.join("bin").join("java.exe");
        if windows.exists() {
            return windows;
        }
    }
    path.to_path_buf()
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

/// The installer must use the console Java binary, not the GUI launcher used
/// for Minecraft on Windows.
pub(crate) fn console_java_exe(path: &Path) -> PathBuf {
    if cfg!(windows) && path.file_name().and_then(|n| n.to_str()) == Some("javaw.exe") {
        let java = path.with_file_name("java.exe");
        if java.exists() {
            return java;
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

fn bundled_runtime_dir(data_dir: &Path, vendor: JavaVendor, major: u32) -> Option<PathBuf> {
    let dir = data_dir.join("runtime").join(vendor.id()).join(format!("java-{major}"));
    if !dir.exists() {
        return None;
    }
    // Маркер полной распаковки: частичная (убитый процесс/диск) проходит
    // проверку java -version, но рантайм битый — JVM падает на каждой загрузке.
    if !dir.join(".complete").exists() {
        return None;
    }
    find_java_home_under(&dir)
}

/// Убирает все уязвимые управляемые рантаймы. Вызывается, когда исправная
/// сборка уже есть в кэше: качать ничего не надо, но строки с красным
/// бейджем CVE в списке установок остались бы висеть.
///
/// Возвращает вендора первого удалённого рантайма (для лога/события UI).
fn drop_stale_vulnerable_runtimes(data_dir: &Path, major: u32) -> Option<JavaVendor> {
    let mut removed = None;
    for vendor in JavaVendor::managed() {
        if remove_vulnerable_runtime(data_dir, vendor, major) {
            removed.get_or_insert(vendor);
        }
    }
    removed
}

/// Удаляет управляемый рантайм вендора — только если он уязвим.
///
/// Вызывается после успешной установки исправной сборки другого вендора,
/// чтобы в списке установок не висела сборка, которую лаунчер уже не
/// использует. Проверка версии здесь обязательна: под тем же каталогом
/// может лежать уже вылеченный рантайм, и его трогать нельзя.
fn remove_vulnerable_runtime(data_dir: &Path, vendor: JavaVendor, major: u32) -> bool {    let Some(dir) = bundled_runtime_dir(data_dir, vendor, major) else {
        return false;
    };
    let exe = version_check_bin(&dir);
    if !probe_java_exe(&exe).is_some_and(|p| is_vulnerable_java(&p.version, p.major)) {
        return false;
    }
    let runtime = data_dir.join("runtime").join(vendor.id()).join(format!("java-{major}"));
    if let Err(err) = fs::remove_dir_all(&runtime) {
        tracing::warn!(
            "[java] не удалось убрать уязвимый {} {major}: {err}",
            vendor.name()
        );
        return false;
    }
    tracing::info!(
        "[java] уязвимый рантайм {} {major} удалён после установки исправной сборки",
        vendor.name()
    );
    true
}

fn bundled_java_for(data_dir: &Path, vendor: JavaVendor, major: u32) -> Option<PathBuf> {    let home = bundled_runtime_dir(data_dir, vendor, major)?;
    let exe = home.join("bin").join(java_bin_name());
    if exe.exists() && probe_java_exe(&version_check_bin(&home)).is_some_and(|p| p.major >= major) {
        Some(exe)
    } else {
        None
    }
}

/// Кэшированный рантайм с отметкой уязвимости и вендором — чтобы Auto мог
/// не только выбрать безопасный, но и обновить единственный уязвимый.
fn bundled_java_entry(data_dir: &Path, major: u32) -> Option<(JavaVendor, PathBuf, bool)> {
    let all: Vec<_> = JavaVendor::managed()
        .into_iter()
        .filter_map(|vendor| {
            let path = bundled_java_for(data_dir, vendor, major)?;
            let vulnerable = probe_java_exe(&version_check_bin(&bundled_home_of(&path)))
                .is_some_and(|p| is_vulnerable_java(&p.version, p.major));
            Some((vendor, path, vulnerable))
        })
        .collect();
    all.iter()
        .find(|(_, _, vulnerable)| !*vulnerable)
        .or_else(|| all.first())
        .cloned()
}

/// Все полные управляемые рантаймы в кэше: (вендор, мажор).
///
/// Кэш держит рантаймы разных мажоров одновременно (например, 21 для
/// старой сборки и 25 для текущей), а игра запускается не обязательно на
/// `JAVA_VERSION`. Поэтому проверка CVE и починка обходят каждый найденный
/// рантайм, а не только 21.
fn cached_managed_runtimes(data_dir: &Path) -> Vec<(JavaVendor, u32)> {
    let mut out = Vec::new();
    for vendor in JavaVendor::managed() {
        let base = data_dir.join("runtime").join(vendor.id());
        let Ok(entries) = fs::read_dir(&base) else {
            continue;
        };
        for entry in entries.flatten() {
            let name = entry.file_name();
            let Some(major) = name
                .to_str()
                .and_then(|s| s.strip_prefix("java-"))
                .and_then(|s| s.parse::<u32>().ok())
            else {
                continue;
            };
            // `.complete` — маркер полной распаковки (см. `bundled_runtime_dir`):
            // недокачанный каталог чинить нечего, его перезапишет следующая
            // загрузка.
            if entry.path().join(".complete").exists() {
                out.push((vendor, major));
            }
        }
    }
    out.sort_by_key(|(vendor, major)| (*major, vendor.id()));
    out
}

/// Версия рантайма из кэша, если он на месте и запускается.
fn cached_runtime_version(
    data_dir: &Path,
    vendor: JavaVendor,
    major: u32,
) -> Option<(String, u32)> {
    let home = bundled_runtime_dir(data_dir, vendor, major)?;
    probe_java_exe(&version_check_bin(&home)).map(|p| (p.version, p.major))
}

/// Мажоры уязвимых управляемых рантаймов в кэше (по возрастанию, без повторов).
fn vulnerable_cached_majors(data_dir: &Path) -> Vec<u32> {
    let mut majors: Vec<u32> = cached_managed_runtimes(data_dir)
        .into_iter()
        .filter(|(vendor, major)| {
            cached_runtime_version(data_dir, *vendor, *major)
                .is_some_and(|(version, m)| is_vulnerable_java(&version, m))
        })
        .map(|(_, major)| major)
        .collect();
    // `cached_managed_runtimes` отсортирован по мажору, поэтому повторы
    // одного мажора у разных вендоров идут подряд.
    majors.dedup();
    majors
}

/// Есть ли у вендора исправный рантайм по одному из мажоров.
///
/// Нужно после починки, чтобы не пересаживать игрока на чужую сборку: если
/// выбранный им вендор уже вылечен по нужным мажорам, настройки менять
/// незачем. Проверяем именно починенные мажоры, а не любые: патченный
/// Corretto 21 у игрока с выбранным Corretto не заменяет Temurin 25, если
/// сборке нужна 25.
pub fn has_patched_runtime(data_dir: &Path, vendor: JavaVendor, majors: &[u32]) -> bool {
    majors.iter().all(|major| {
        cached_runtime_version(data_dir, vendor, *major)
            .is_some_and(|(version, m)| !is_vulnerable_java(&version, m))
    })
}

/// `<home>/bin/java` → `<home>`.
fn bundled_home_of(exe: &Path) -> PathBuf {
    exe.parent()
        .and_then(Path::parent)
        .map(Path::to_path_buf)
        .unwrap_or_else(|| exe.to_path_buf())
}

/// Отметка «смотрели, что раздаёт вендор».
///
/// Нужна только чтобы не дёргать сеть на каждом запуске: сама по себе она
/// ничего не решает, перекачка идёт лишь когда версия у вендора новее.
fn vendor_check_marker(data_dir: &Path, vendor: JavaVendor, major: u32) -> PathBuf {
    data_dir
        .join("runtime")
        .join(vendor.id())
        .join(format!(".vendor-check-{major}"))
}

fn should_check_vendor(data_dir: &Path, vendor: JavaVendor, major: u32) -> bool {
    // Раз в сутки: фиксы выходят не каждую минуту, а лишние запросы на
    // каждый старт лаунчера бессмысленны. Если вендор отдал ту же версию,
    // ничего не качаем — при следующем старте спросим снова.
    const CHECK_SECS: u64 = 24 * 60 * 60;
    let marker = vendor_check_marker(data_dir, vendor, major);
    let Some(modified) = fs::metadata(&marker).and_then(|m| m.modified()).ok() else {
        return true;
    };
    modified
        .elapsed()
        .map(|age| age.as_secs() >= CHECK_SECS)
        .unwrap_or(true)
}

fn mark_vendor_check(data_dir: &Path, vendor: JavaVendor, major: u32) {
    let marker = vendor_check_marker(data_dir, vendor, major);
    if let Some(parent) = marker.parent() {
        let _ = fs::create_dir_all(parent);
    }
    let _ = fs::write(&marker, b"checked");
}

/// Что вендор раздаёт прямо сейчас: `21.0.13.1` / `21.0.13+9` → `21.0.13.1`.
///
/// Спрашиваем по-разному: у Adoptium и Zulu есть метаданные-API, у Corretto
/// и Microsoft — только редирект `latest`, из имени файла которого и
/// достаётся версия (HEAD без тела).
async fn vendor_latest_version(
    vendor: JavaVendor,
    http: &reqwest::Client,
    major: u32,
) -> Result<String, String> {
    let version = match vendor {
        JavaVendor::Temurin => {
            let arch = if cfg!(target_arch = "aarch64") { "aarch64" } else { "x64" };
            let os = if cfg!(target_os = "macos") {
                "mac"
            } else if cfg!(target_os = "linux") {
                "linux"
            } else {
                "windows"
            };
            let body: serde_json::Value = http
                .get(format!(
                    "https://api.adoptium.net/v3/assets/latest/{major}/hotspot?architecture={arch}&image_type=jre&os={os}&vendor=eclipse"
                ))
                .send()
                .await
                .map_err(|e| format!("Adoptium API: {e}"))?
                .error_for_status()
                .map_err(|e| format!("Adoptium API: {e}"))?
                .json()
                .await
                .map_err(|e| format!("Adoptium API: {e}"))?;
            // `semver` у Adoptium — это `21.0.13+100000002.0.LTS`, а не версия
            // сборки: номер респина в нём зашит в поле билда. Если взять его,
            // `version_from_artifact` вернёт `21.0.13`, и Adoptium навсегда
            // выглядит уязвимым, даже когда раздаёт `21.0.13.1`. Берём
            // `release_name` (`jdk-21.0.13.1+2`) или `openjdk_version`.
            body.get(0)
                .and_then(|r| r.get("release_name"))
                .and_then(|v| v.as_str())
                .map(str::to_string)
                .or_else(|| {
                    body.get(0)
                        .and_then(|r| r.get("version"))
                        .and_then(|v| v.get("openjdk_version"))
                        .and_then(|v| v.as_str())
                        .map(str::to_string)
                })
                .ok_or_else(|| "Adoptium API: не удалось прочитать версию".to_string())?
        }
        JavaVendor::Corretto | JavaVendor::Microsoft | JavaVendor::Oracle => {
            // HEAD: `latest`-ссылка редиректит на файл с версией в имени.
            let url = resolve_download_url(vendor, http, major).await?;
            let resp = http
                .head(&url)
                .send()
                .await
                .map_err(|e| format!("{}: {e}", vendor.name()))?
                .error_for_status()
                .map_err(|e| format!("{}: {e}", vendor.name()))?;
            resp.url()
                .path_segments()
                .and_then(|mut segments| segments.next_back())
                .map(str::to_string)
                .ok_or_else(|| format!("{}: не удалось определить версию", vendor.name()))?
        }
        JavaVendor::Zulu => {
            // Zulu-API отдаёт `java_version` пакета; на `latest=true` берём первый.
            let platform = current_platform();
            let (os, arch) = match (platform.os, platform.arch) {
                ("macos", "aarch64") => ("macos", "arm"),
                ("macos", "x64") => ("macos", "x86_64"),
                ("linux", "aarch64") => ("linux", "aarch64"),
                ("linux", "x64") => ("linux", "x86_64"),
                ("windows", "aarch64") => ("windows", "aarch64"),
                ("windows", "x64") => ("windows", "x86_64"),
                _ => ("linux", "x86_64"),
            };
            let body: serde_json::Value = http
                .get(format!(
                    "https://api.azul.com/metadata/v1/zulu/packages/?java_version={major}&os={os}&arch={arch}&java_package_type=jre&availability_types=ca&release_status=ga&latest=true&distribution=zulu"
                ))
                .send()
                .await
                .map_err(|e| format!("Azul API: {e}"))?
                .error_for_status()
                .map_err(|e| format!("Azul API: {e}"))?
                .json()
                .await
                .map_err(|e| format!("Azul API: {e}"))?;
            let parts = body
                .get(0)
                .and_then(|p| p.get("java_version"))
                .and_then(|v| v.as_array())
                .ok_or_else(|| "Azul API: не удалось прочитать версию".to_string())?;
            parts
                .iter()
                .filter_map(|v| v.as_u64())
                .map(|v| v.to_string())
                .collect::<Vec<_>>()
                .join(".")
        }
    };
    Ok(version)
}

/// Версия из имени файла: `amazon-corretto-21.0.13.1.2-linux-x64.tar.gz` →
/// `21.0.13.1.2`, `microsoft-jdk-21.0.13.0.2-macos-aarch64.tar.gz` → `21.0.13.0.2`,
/// `OpenJDK21U-jre_x64_linux_hotspot_21.0.13_9.tar.gz` → `21.0.13`.
///
/// В именах вендоров версия идёт ПЕРВЫМ сегментом из цифр и точек сразу
/// после названия продукта (в хвосте — биты платформы вроде `64`/`9`).
fn version_from_artifact(name: &str) -> Option<String> {
    let bytes = name.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i].is_ascii_digit() {
            let start = i;
            while i < bytes.len() && (bytes[i].is_ascii_digit() || bytes[i] == b'.') {
                i += 1;
            }
            let candidate = name[start..i].trim_end_matches('.');
            // Нужен хотя бы `X.Y`: одиночные числа — это `64`, `9`, `21` из
            // `OpenJDK21U`.
            if candidate.matches('.').count() >= 1 {
                return Some(candidate.to_string());
            }
        }
        i += 1;
    }
    None
}

/// Версии, которые вендоры раздают прямо сейчас, — для выбора источника
/// исправленной сборки, когда у выбранного вендора фикса ещё нет.
///
/// Вендор без автозагрузки этого мажора отбрасывается сразу: иначе мы бы
/// выбрали его по версии, а `download_java_version` упал на валидации и
/// сломал запуск.
fn fixed_vendor_candidates(vendor: JavaVendor, major: u32) -> impl Iterator<Item = JavaVendor> {
    JavaVendor::managed()
        .into_iter()
        .filter(move |v| *v != vendor && validate_download_vendor(*v, major).is_ok())
}

async fn ensure_downloaded_java(
    vendor: JavaVendor,
    progress: &Progress,
    http: &reqwest::Client,
    data_dir: &Path,
    major: u32,
) -> Result<PathBuf, String> {
    let own = bundled_java_for(data_dir, vendor, major);
    let own_vulnerable = own.as_ref().is_some_and(|java| {
        probe_java_exe(&version_check_bin(&bundled_home_of(java)))
            .is_some_and(|p| is_vulnerable_java(&p.version, p.major))
    });

    if let Some(java) = own.as_ref().filter(|_| !own_vulnerable) {
        return Ok(java.clone());
    }

    // Кэша выбранного вендора нет (или он уязвим). Перед сетью смотрим,
    // нет ли в кэше исправленной сборки ДРУГОГО вендора: фикс мог быть
    // скачан в прошлый раз, и тогда качать его повторно незачем.
    if let Some((source, java, vulnerable)) = bundled_java_entry(data_dir, major) {
        if !vulnerable {
            if own_vulnerable {
                tracing::warn!(
                    "[java] {} уязвима к CVE-2026-114938 — берём исправленную сборку {} из кэша",
                    vendor.name(),
                    source.name()
                );
            } else {
                tracing::info!(
                    "[java] берём исправленную сборку {} из кэша",
                    source.name()
                );
            }
            return Ok(java);
        }
    }

    if let Some(java) = own {
        // Кэш уязвим (CVE-2026-114938) — но обновление имеет смысл, только
        // если вендор УЖЕ выпустил исправленную сборку. Таймер тут не
        // годится: он бы либо тянул 50 МБ каждый запуск, либо навсегда
        // пропускал вышедший фикс. Спрашиваем версию у вендора.
        let cached = probe_java_exe(&version_check_bin(&bundled_home_of(&java)))
            .map(|p| p.version)
            .unwrap_or_default();
        if !should_check_vendor(data_dir, vendor, major) {
            tracing::warn!(
                "[java] {} Java {major} уязвима к CVE-2026-114938 (версию вендора проверяли недавно)",
                vendor.name()
            );
            return Ok(java);
        }
        mark_vendor_check(data_dir, vendor, major);
        match vendor_latest_version(vendor, http, major).await {
            Ok(latest) => {
                let latest = version_from_artifact(&latest).unwrap_or(latest);
                if version_less(&cached, &latest) {
                    tracing::warn!(
                        "[java] {} раздаёт {latest} вместо уязвимой {cached} — обновляем",
                        vendor.name()
                    );
                    return match download_java_version(vendor, progress, http, data_dir, major).await {
                        Ok(fresh) => Ok(fresh),
                        // Сеть/диск подвели — играть на кэше можно.
                        Err(err) => {
                            tracing::warn!("[java] не удалось обновить уязвимую Java: {err}");
                            Ok(java)
                        }
                    };
                }
                tracing::warn!(
                    "[java] {} всё ещё раздаёт уязвимую {cached} — ищем фикс у других вендоров",
                    vendor.name()
                );
            }
            Err(err) => {
                tracing::warn!("[java] не удалось узнать версию {}: {err}", vendor.name());
            }
        }
        // У выбранного вендора фикса ещё нет — забираем его у того, кто
        // уже перевыпустил сборку. Это честнее, чем оставить игрока на CVE.
        if let Some(fixed) = first_vendor_with_fix(vendor, http, major).await {
            tracing::warn!(
                "[java] у {} фикса нет — скачиваем исправленную сборку {}",
                vendor.name(),
                fixed.name()
            );
            return match download_java_version(fixed, progress, http, data_dir, major).await {
                Ok(path) => Ok(path),
                Err(err) => {
                    tracing::warn!("[java] не удалось скачать фикс у {}: {err}", fixed.name());
                    Ok(java)
                }
            };
        }
        return Ok(java);
    }

    // Кэша нет вообще (чистая система): у выбранного вендора фикса может
    // ещё не быть, а у соседнего — уже есть. Скачиваем исправленную сборку
    // сразу, чтобы не ставить заведомо дырявую Java.
    download_fixed_java(vendor, progress, http, data_dir, major)
        .await
        .map(|(path, _)| path)
}

/// Результат починки: что поставили и что не удалось (если удалось не всё).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FixedJava {
    pub path: String,
    /// Вендор установленной сборки — чтобы настройки указывали именно на неё.
    pub vendor: String,
    /// Мажоры, для которых встала исправная сборка.
    pub patched_majors: Vec<u32>,
    /// Непусто, если часть мажоров починить не вышло: окно покажет это
    /// предупреждение, а не бодрое «Java обновлена».
    pub warning: Option<String>,
}

/// Ставит исправленную сборку Java по явному требованию игрока (кнопка
/// «Исправить» рядом с предупреждением о CVE-2026-114938).
///
/// Отличие от [`refresh_vulnerable_cached_java`]: та работает фоном и молчит,
/// когда фикса нет или ссылку уже проверяли сутки назад. Здесь игрок нажал
/// кнопку и ждёт результат, поэтому маркер суточной проверки игнорируется, а
/// отсутствие фикса у всех вендоров — явная ошибка, а не «ничего не произошло».
///
/// Чиним КАЖДЫЙ уязвимый рантайм в кэше, а не только Java 21: сборка может
/// требовать 25 (или 17), и уязвимая сборка этого мажора торчала бы красным
/// бейджем после успешной починки 21.
///
/// Предпочтение — вендору текущего рантайма: игрок мог выбрать Corretto, и
/// молча пересаживать его на Temurin только из-за CVE невежливо. Если у
/// выбранного вендора фикса нет, берём первого, у кого он есть.
pub async fn install_fixed_java(
    preferred: Option<JavaVendor>,
    progress: &Progress,
    http: &reqwest::Client,
    data_dir: &Path,
) -> Result<FixedJava, String> {
    let vendor = preferred.unwrap_or(JavaVendor::Temurin);
    let mut targets = vulnerable_cached_majors(data_dir);
    // Уязвимых рантаймов в кэше нет (например, чинили раньше, а бейдж
    // остался от системной Java): чиним тот мажор, который нужен для
    // запуска по умолчанию, — это единственный заведомо полезный вариант.
    if targets.is_empty() {
        targets.push(JAVA_VERSION);
    }

    progress.begin(
        crate::progress::Stage::Java,
        "checking",
        format!("Проверяем исправленные сборки Java {}…", major_list(&targets)),
    );

    let mut installed: Option<(JavaVendor, PathBuf)> = None;
    let mut patched_majors: Vec<u32> = Vec::new();
    let mut errors: Vec<String> = Vec::new();
    for major in targets {
        match install_fixed_java_major(vendor, major, progress, http, data_dir).await {
            Ok(path) => {
                // Уязвимые рантаймы других вендоров этого мажора больше не
                // нужны: без удаления бейдж CVE просто переедет на соседнюю
                // строку списка.
                drop_stale_vulnerable_runtimes(data_dir, major);
                installed = Some(path);
                patched_majors.push(major);
            }
            // Один непочиненный мажор не должен отменять уже установленные.
            Err(err) => errors.push(format!("Java {major}: {err}")),
        }
    }
    // Успех при частичной неудаче обманул бы игрока: окно сказало бы «Java
    // обновлена», а бейдж на непочиненном мажоре остался бы. Поэтому неудача
    // любого мажора попадает в `warning`, а не проглатывается.
    if let Some((fixed, path)) = installed {
        return Ok(FixedJava {
            path: path.to_string_lossy().into_owned(),
            vendor: fixed.id().to_string(),
            patched_majors,
            warning: (!errors.is_empty()).then(|| {
                format!(
                    "Не всё удалось обновить — {}. Повторите позже.",
                    errors.join("; ")
                )
            }),
        });
    }
    Err(errors.join(" "))
}

/// Починка одного мажора: та же логика, что была у `install_fixed_java`.
async fn install_fixed_java_major(
    vendor: JavaVendor,
    major: u32,
    progress: &Progress,
    http: &reqwest::Client,
    data_dir: &Path,
) -> Result<(JavaVendor, PathBuf), String> {
    // Сначала сам выбранный вендор: `first_vendor_with_fix` его намеренно
    // пропускает (он нужен для случая «у нашего фикса нет»), а здесь игрок
    // ждёт результат именно от своей сборки, если та уже исправна.
    //
    // Проверяем и то, что вендор вообще умеет качать этот мажор: у Corretto
    // закреплена ссылка только на 21, и `vendor_latest_version` вернул бы
    // версию 21, которая «новее» порога 17 — иначе починка 17 падала бы на
    // валидации загрузки вместо того, чтобы взять Temurin.
    let own_fixed = validate_download_vendor(vendor, major).is_ok()
        && match vendor_latest_version(vendor, http, major).await {
            Ok(latest) => {
                let version = version_from_artifact(&latest).unwrap_or(latest);
                !is_vulnerable_java(&version, major)
            }
            Err(err) => {
                tracing::debug!("[java] версия {} недоступна: {err}", vendor.name());
                false
            }
        };
    let fixed = if own_fixed {
        vendor
    } else {
        match first_vendor_with_fix(vendor, http, major).await {
            Some(fixed) => fixed,
            None => {
                return Err(format!(
                    "Пока ни один поставщик не раздаёт исправленную Java {major} \
                     (уязвимы сборки старше {}). Попробуйте позже.",
                    fixed_java_label(major)
                ));
            }
        }
    };
    let path = download_java_version(fixed, progress, http, data_dir, major).await?;
    Ok((fixed, path))
}

/// `21` / `21 и 25` — для текста прогресса.
fn major_list(majors: &[u32]) -> String {
    majors
        .iter()
        .map(u32::to_string)
        .collect::<Vec<_>>()
        .join(" и ")
}

/// Порог фикса в человекочитаемом виде — для текста ошибки.
fn fixed_java_label(major: u32) -> String {
    match fixed_java_version(major) {
        Some([a, b, c, d]) => format!("{a}.{b}.{c}.{d}"),
        _ => major.to_string(),
    }
}

/// Фоновая проверка кэша: если хоть один управляемый рантайм уязвим —
/// смотрим, не выпустил ли его вендор фикс, и перекачиваем.
///
/// Пробегает ВСЕ мажоры в кэше, а не только `JAVA_VERSION`: сборка может
/// требовать 25, и уязвимый рантайм 25 иначе оставался бы с бейджем
/// навсегда — кнопка «Исправить» и фон чинили бы только 21.
///
/// Возвращает вендора первой обновлённой сборки, либо `None`, если обновлять
/// нечего (фикса нет / сети нет / маркер не истёк). Ошибка — только если
/// обновление началось и упало.
pub async fn refresh_vulnerable_cached_java(
    progress: &Progress,
    http: &reqwest::Client,
    data_dir: &Path,
) -> Result<Option<JavaVendor>, String> {
    let mut majors = vulnerable_cached_majors(data_dir);
    // Кэш пуст (чистая система): качать нечего.
    if majors.is_empty() {
        majors.push(JAVA_VERSION);
    }

    let mut updated = None;
    for major in majors {
        // Сбой на одном мажоре не должен отменять починку остальных: 21 и 25
        // чинятся независимо, и падение сети на 25 оставляло бы 21 уязвимой.
        match refresh_vulnerable_cached_java_major(progress, http, data_dir, major).await {
            Ok(Some(vendor)) => {
                updated.get_or_insert(vendor);
            }
            Ok(None) => {}
            Err(err) => tracing::warn!("[java] не удалось обновить Java {major}: {err}"),
        }
    }
    Ok(updated)
}

/// Починка кэша одного мажора; тело прежней `refresh_vulnerable_cached_java`.
async fn refresh_vulnerable_cached_java_major(
    progress: &Progress,
    http: &reqwest::Client,
    data_dir: &Path,
    major: u32,
) -> Result<Option<JavaVendor>, String> {
    // Исправная сборка этого мажора уже лежит в кэше: игра её и возьмёт
    // (см. `ensure_downloaded_java`), качать вторую незачем — иначе уязвимый
    // рантайм, оставшийся по соседству, тянул бы фикс заново каждый день.
    if bundled_java_entry(data_dir, major).is_some_and(|(_, _, vulnerable)| !vulnerable) {
        // Но уязвимые рантаймы рядом всё ещё торчат в списке установок
        // красным бейджем — убираем их все, раз уж есть чем заменить.
        return Ok(drop_stale_vulnerable_runtimes(data_dir, major));
    }
    for vendor in JavaVendor::managed() {
        let Some(java) = bundled_java_for(data_dir, vendor, major) else {
            continue;
        };
        let vulnerable = probe_java_exe(&version_check_bin(&bundled_home_of(&java)))
            .is_some_and(|p| is_vulnerable_java(&p.version, p.major));
        if !vulnerable {
            continue;
        }
        // Тот же маркер, что у запуска игры: не дёргаем сеть чаще раза в
        // сутки, но и не пропускаем вышедший фикс.
        if !should_check_vendor(data_dir, vendor, major) {
            continue;
        }
        // Явно проверяем наличие фикса: download_fixed_java без него
        // скачал бы ту же уязвимую сборку заново. Сначала спрашиваем САМОГО
        // вендора — `first_vendor_with_fix` его пропускает, а для Java 25
        // других кандидатов нет вовсе (остальные вендоры не умеют качать 25),
        // и фон не чинил бы её никогда.
        let fixed = if vendor_latest_version(vendor, http, major)
            .await
            .ok()
            .map(|latest| version_from_artifact(&latest).unwrap_or(latest))
            .is_some_and(|version| !is_vulnerable_java(&version, major))
        {
            Some(vendor)
        } else {
            first_vendor_with_fix(vendor, http, major).await
        };
        let Some(fixed) = fixed else {
            mark_vendor_check(data_dir, vendor, major);
            tracing::warn!(
                "[java] {} и остальные вендоры пока раздают уязвимую Java {major}",
                vendor.name()
            );
            continue;
        };
        // Отмечаем ДО скачивания: иначе сбой посреди загрузки оставит нас
        // в цикле «начать и упасть» на каждом следующем старте.
        mark_vendor_check(data_dir, vendor, major);
        match download_java_version(fixed, progress, http, data_dir, major).await {
            Ok(_) => {
                // Уязвимый рантайм больше не нужен: без удаления он остаётся
                // в списке установок, и игрок продолжает видеть красный
                // бейдж CVE на сборке, которую лаунчер уже не использует.
                // Уязвимый рантайм мог остаться и у другого вендора —
                // чистим все, иначе бейдж просто переедет на соседнюю строку.
                drop_stale_vulnerable_runtimes(data_dir, major);
                return Ok(Some(fixed));
            }
            Err(err) => return Err(err),
        }
    }
    Ok(None)
}

/// Скачивание на чистой системе с выбором вендора, у которого уже есть фикс.
///
/// Возвращает путь и ФАКТИЧЕСКОГО вендора: он может отличаться от
/// запрошенного, если фикс CVE-2026-114938 есть только у соседа.
async fn download_fixed_java(
    vendor: JavaVendor,
    progress: &Progress,
    http: &reqwest::Client,
    data_dir: &Path,
    major: u32,
) -> Result<(PathBuf, JavaVendor), String> {
    if let Some(fixed) = first_vendor_with_fix(vendor, http, major).await {
        tracing::warn!(
            "[java] у {} нет фикса CVE-2026-114938 — скачиваем исправленную сборку {}",
            vendor.name(),
            fixed.name()
        );
        let path = download_java_version(fixed, progress, http, data_dir, major).await?;
        return Ok((path, fixed));
    }
    let path = download_java_version(vendor, progress, http, data_dir, major).await?;
    Ok((path, vendor))
}

/// Первый вендор (кроме выбранного), который уже раздаёт исправленную сборку.
async fn first_vendor_with_fix(
    requested: JavaVendor,
    http: &reqwest::Client,
    major: u32,
) -> Option<JavaVendor> {
    let mut latest_versions = Vec::new();
    for vendor in fixed_vendor_candidates(requested, major) {
        match vendor_latest_version(vendor, http, major).await {
            Ok(latest) => {
                let latest = version_from_artifact(&latest).unwrap_or(latest);
                tracing::debug!("[java] {} раздаёт {latest}", vendor.name());
                latest_versions.push((vendor, latest));
            }
            Err(err) => tracing::debug!("[java] версия {} недоступна: {err}", vendor.name()),
        }
    }
    let fixed = pick_fixed_vendor(&latest_versions, major);
    if let Some(vendor) = fixed {
        tracing::info!("[java] {} уже раздаёт исправленную сборку", vendor.name());
    }
    fixed
}

/// Выбор вендора с фиксом по снимку «кто что раздаёт».
///
/// Отдельно от сетевой обёртки: порядок обхода фиксирован (`managed()`),
/// поэтому результат детерминирован и проверяется тестом.
fn pick_fixed_vendor(latest_versions: &[(JavaVendor, String)], major: u32) -> Option<JavaVendor> {
    latest_versions
        .iter()
        .find(|(_, latest)| !is_vulnerable_java(latest, major))
        .map(|(vendor, _)| *vendor)
}

/// Скачивание Java по явному запросу («Скачать» в настройках).
///
/// Возвращает путь и фактического вендора: если у запрошенного фикса
/// CVE-2026-114938 ещё нет, ставим исправленную сборку соседа.
pub async fn download_java(
    vendor: JavaVendor,
    progress: &Progress,
    http: &reqwest::Client,
    data_dir: &Path,
) -> Result<(PathBuf, JavaVendor), String> {
    download_fixed_java(vendor, progress, http, data_dir, JAVA_VERSION).await
}

async fn download_java_version(
    vendor: JavaVendor,
    progress: &Progress,
    http: &reqwest::Client,
    data_dir: &Path,
    major: u32,
) -> Result<PathBuf, String> {
    // Для остальных поставщиков в коде закреплены только проверенные URL Java 21.
    validate_download_vendor(vendor, major)?;
    let vendor_name = list_download_vendors()
        .into_iter()
        .find(|v| v.id == vendor.id())
        .map(|v| v.name)
        .unwrap_or_else(|| vendor.id().to_string());

    progress.begin(
        crate::progress::Stage::Java,
        "downloading",
        format!("Скачиваем {vendor_name} Java {major}…"),
    );

    let runtime_dir = data_dir.join("runtime").join(vendor.id()).join(format!("java-{major}"));
    // Скачиваем и распаковываем в staging-каталог, старый runtime удаляем
    // только ПОСЛЕ успешной распаковки нового. Раньше remove_dir_all шёл
    // первым: сбой сети посреди загрузки оставлял юзера вообще без Java
    // (в оффлайне игра не запускалась).
    let staging_dir = data_dir
        .join("runtime")
        .join(vendor.id())
        .join(format!(".staging-java-{major}"));
    let _ = fs::remove_dir_all(&staging_dir);
    fs::create_dir_all(&staging_dir)
        .map_err(|e| format!("Не удалось создать staging-каталог Java: {e}"))?;

    let url = resolve_download_url(vendor, http, major).await?;
    let archive_format = archive_format_for_url(&url);

    if archive_format == JavaArchiveFormat::Zip {
        let archive = data_dir
            .join("runtime")
            .join(format!("java-{major}-{}.zip", vendor.id()));
        crate::minecraft::download_to(
            progress,
            http,
            &url,
            &archive,
            &format!("Java {major} runtime"),
            None,
            None,
        )
        .await?;
        validate_archive_header(&archive, JavaArchiveFormat::Zip)?;
        progress.set_label("extracting", format!("Распаковываем Java {major}…"));
        extract_java_zip(&archive, &staging_dir)?;
        let _ = fs::remove_file(&archive);
    } else {
        let archive = data_dir
            .join("runtime")
            .join(format!("java-{major}-{}.tar.gz", vendor.id()));
        crate::minecraft::download_to(
            progress,
            http,
            &url,
            &archive,
            &format!("Java {major} runtime"),
            None,
            None,
        )
        .await?;
        validate_archive_header(&archive, JavaArchiveFormat::TarGz)?;
        progress.set_label("extracting", format!("Распаковываем Java {major}…"));
        extract_java_tar_gz(&archive, &staging_dir)?;
        let _ = fs::remove_file(&archive);
    }

    finalize_extracted_java(&staging_dir)?;
    let staged_home = find_java_home_under(&staging_dir)
        .ok_or_else(|| "JAVA_HOME не найден после распаковки".to_string())?;
    validate_java_exe(&version_check_bin(&staged_home), major)?;

    // Всё скачалось и распаковалось — теперь безопасно заменить старый runtime.
    if runtime_dir.exists() {
        fs::remove_dir_all(&runtime_dir)
            .map_err(|e| format!("Не удалось очистить runtime Java: {e}"))?;
    }
    fs::rename(&staging_dir, &runtime_dir).map_err(|e| {
        format!(
            "Не удалось переместить новый runtime Java ({staging} -> {target}): {e}",
            staging = staging_dir.display(),
            target = runtime_dir.display()
        )
    })?;
    let _ = fs::remove_dir_all(&staging_dir);

    bundled_java_for(data_dir, vendor, major).ok_or_else(|| {
        format!(
            "Java {major} скачана, но java не найдена в {}",
            runtime_dir.to_string_lossy()
        )
    })
}

fn validate_download_vendor(vendor: JavaVendor, major: u32) -> Result<(), String> {
    if major != JAVA_VERSION && vendor != JavaVendor::Temurin {
        return Err(format!("Для {} автоматическая загрузка Java {major} не поддерживается. Выберите Temurin, системную или свою Java {major}+.", vendor.name()));
    }
    Ok(())
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
    let arch = if cfg!(target_arch = "aarch64") {
        "aarch64"
    } else {
        "x64"
    };
    if cfg!(target_os = "macos") {
        Platform { os: "macos", arch }
    } else if cfg!(target_os = "linux") {
        Platform { os: "linux", arch }
    } else {
        Platform {
            os: "windows",
            arch,
        }
    }
}

async fn resolve_download_url(
    vendor: JavaVendor,
    http: &reqwest::Client,
    major: u32,
) -> Result<String, String> {
    match vendor {
        JavaVendor::Temurin => Ok(temurin_url(major)),
        JavaVendor::Corretto => Ok(corretto_url()),
        JavaVendor::Microsoft => Ok(microsoft_url()),
        JavaVendor::Oracle => Ok(oracle_url()),
        JavaVendor::Zulu => resolve_zulu_url(http).await,
    }
}

fn temurin_url(major: u32) -> String {
    let arch = if cfg!(target_arch = "aarch64") {
        "aarch64"
    } else {
        "x64"
    };
    let os = if cfg!(target_os = "macos") {
        "mac"
    } else if cfg!(target_os = "linux") {
        "linux"
    } else {
        "windows"
    };
    format!(
        "https://api.adoptium.net/v3/binary/latest/{major}/ga/{os}/{arch}/jre/hotspot/normal/eclipse"
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
        ("linux", "aarch64") => {
            "https://corretto.aws/downloads/latest/amazon-corretto-21-aarch64-linux-jdk.tar.gz"
        }
        ("linux", "x64") => {
            "https://corretto.aws/downloads/latest/amazon-corretto-21-x64-linux-jdk.tar.gz"
        }
        ("windows", "aarch64") => {
            "https://corretto.aws/downloads/latest/amazon-corretto-21-aarch64-windows-jdk.zip"
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
        ("linux", "aarch64") => {
            "https://aka.ms/download-jdk/microsoft-jdk-21.0.7-linux-aarch64.tar.gz"
        }
        ("linux", "x64") => "https://aka.ms/download-jdk/microsoft-jdk-21.0.7-linux-x64.tar.gz",
        ("windows", "aarch64") => {
            "https://aka.ms/download-jdk/microsoft-jdk-21.0.7-windows-aarch64.zip"
        }
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
        ("linux", "aarch64") => {
            "https://download.oracle.com/java/21/latest/jdk-21_linux-aarch64_bin.tar.gz"
        }
        ("linux", "x64") => {
            "https://download.oracle.com/java/21/latest/jdk-21_linux-x64_bin.tar.gz"
        }
        ("windows", "aarch64") => {
            "https://download.oracle.com/java/21/latest/jdk-21_windows-aarch64_bin.zip"
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
        ("linux", "aarch64") => ("linux", "aarch64"),
        ("linux", "x64") => ("linux", "x86_64"),
        ("windows", "aarch64") => ("windows", "aarch64"),
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

    // Рантайм полностью распакован — с этого момента считаем валидным
    // (маркер проверяется в `bundled_runtime_dir`).
    fs::write(runtime_dir.join(".complete"), b"ok")
        .map_err(|e| format!("Не удалось записать маркер Java runtime: {e}"))?;

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
            // Path traversal: цель симлинка проходит ту же проверку, что и путь
            // записи. Абсолютная цель или содержащая `..` после склейки с
            // каталогом записи позволяет последующим файлам писать ЗА пределы
            // runtime (например, `lib -> ../../../../Users/x/Library`, затем
            // `lib/LaunchAgents/evil.plist`). JDK для запуска `java` симлинки
            // с такими целями не содержит — отказываемся целиком.
            let link_str = link.to_string_lossy();
            if link.is_absolute() {
                return Err(format!(
                    "Небезопасный симлинк в tar: {stripped} -> {link_str} (абсолютная цель)"
                ));
            }
            if link
                .components()
                .any(|c| matches!(c, Component::ParentDir))
            {
                return Err(format!(
                    "Небезопасный симлинк в tar: {stripped} -> {link_str} (выход за пределы каталога)"
                ));
            }
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
    fn download_selection_preserves_java_21_and_supports_temurin_25() {
        assert!(temurin_url(21).contains("/latest/21/"));
        assert!(temurin_url(25).contains("/latest/25/"));
        for vendor in JavaVendor::managed() {
            assert!(validate_download_vendor(vendor, 21).is_ok());
        }
        assert!(validate_download_vendor(JavaVendor::Temurin, 25).is_ok());
        assert!(validate_download_vendor(JavaVendor::Microsoft, 25).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn managed_runtimes_are_separate_and_requirement_is_checked() {
        use std::os::unix::fs::PermissionsExt;
        let root = std::env::temp_dir().join(format!("stardust-java-versions-{}-{}", std::process::id(), std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
        for major in [21, 25] {
            let runtime = root.join("runtime/temurin").join(format!("java-{major}"));
            fs::create_dir_all(runtime.join("bin")).unwrap();
            fs::write(runtime.join(".complete"), b"ok").unwrap();
            let exe = runtime.join("bin/java");
            // Кавычки внутри одинарных кавычек printf не экранируем: на Linux
            // /bin/sh — это dash, который печатает \" буквально (в отличие от
            // bash на macOS), и парсер версии не находит маркер.
            fs::write(&exe, format!("#!/bin/sh\nprintf 'openjdk version \"{major}.0.1\"\\n' >&2\n")).unwrap();
            fs::set_permissions(&exe, fs::Permissions::from_mode(0o755)).unwrap();
        }
        let j21 = bundled_java_for(&root, JavaVendor::Temurin, 21).unwrap();
        let j25 = bundled_java_for(&root, JavaVendor::Temurin, 25).unwrap();
        assert_ne!(j21, j25);
        assert!(validate_java_exe(&j21, 25).is_err());
        assert!(validate_java_exe(&j25, 25).is_ok());
        assert!(bundled_runtime_dir(&root, JavaVendor::Temurin, 21).is_some());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn parse_java_major_handles_modern_and_legacy() {
        assert_eq!(parse_java_major("21.0.11"), Some(21));
        assert_eq!(parse_java_major("1.8.0_402"), Some(8));
    }

    #[test]
    fn cve_2026_114938_flags_unpatched_21() {
        // Ровно версии из бюллетеня Oracle — уязвимы.
        assert!(is_vulnerable_java("21.0.13", 21));
        assert!(is_vulnerable_java("17.0.21", 17));
        assert!(is_vulnerable_java("25.0.5", 25));
        assert!(is_vulnerable_java("27.0.1", 27));
        // Перевыпуски с четвёртой цифрой содержат фикс.
        assert!(!is_vulnerable_java("21.0.13.1", 21));
        assert!(!is_vulnerable_java("21.0.13.1+2", 21));
        assert!(!is_vulnerable_java("17.0.21.1", 17));
        assert!(!is_vulnerable_java("25.0.5.1", 25));
        assert!(!is_vulnerable_java("27.0.1.1", 27));
        // Более новые минорки безопасны по определению порога.
        assert!(!is_vulnerable_java("21.0.14", 21));
        assert!(!is_vulnerable_java("22.0.1", 22));
        // Баг появился в 17.0.6: ровно с неё путь уже уязвим, раньше — нет.
        assert!(!is_vulnerable_java("17.0.5", 17));
        assert!(is_vulnerable_java("17.0.6", 17));
        assert!(is_vulnerable_java("17.0.7", 17));
        // Не-LTS ветки в бюллетене не фигурируют — не трогаем.
        assert!(!is_vulnerable_java("11.0.33", 11));
        assert!(!is_vulnerable_java("8u511b33", 8));
        // Неизвестный формат версии: сборку считаем уязвимой, чтобы
        // предупреждение не потерялось, но требуемую версию не блокируем.
        assert!(is_vulnerable_java("", 21));
    }

    #[test]
    fn cpu_exposure_requires_avx512_vbmi() {
        // На ARM64 уязвимый путь не исполняется; на x86-64 с AVX-512 VBMI —
        // да. Тест-хост может быть любым, поэтому проверяем согласованность:
        // exposure без AVX-512 VBMI/AVX-512F/BMI2 невозможен.
        let exposed = cpu_reaches_vulnerable_base64();
        #[cfg(any(target_arch = "x86", target_arch = "x86_64"))]
        {
            let all = is_x86_feature_detected!("avx512f")
                && is_x86_feature_detected!("avx512bw")
                && is_x86_feature_detected!("avx512vbmi")
                && is_x86_feature_detected!("bmi2");
            assert_eq!(exposed, all);
        }
        #[cfg(not(any(target_arch = "x86", target_arch = "x86_64")))]
        assert!(!exposed);
    }

    #[test]
    fn fixed_java_label_names_the_patch_threshold() {
        // Текст ошибки кнопки «Исправить» называет версию, начиная с которой
        // сборка считается исправной — иначе игрок не понимает, чего ждать.
        assert_eq!(fixed_java_label(21), "21.0.13.1");
        assert_eq!(fixed_java_label(17), "17.0.21.1");
        // Ветка без фикса в бюллетене: показываем только мажор.
        assert_eq!(fixed_java_label(8), "8");
    }

    #[test]
    fn pick_fixed_vendor_skips_vendors_without_update() {
        // Реальная картина на 2026-11-18: Adoptium раздаёт уязвимый
        // 21.0.13+9, Corretto и Zulu — исправленный 21.0.13.1.
        let snapshot = vec![
            (JavaVendor::Temurin, "21.0.13+9.0.LTS".to_string()),
            (JavaVendor::Corretto, "21.0.13.1.2".to_string()),
            (JavaVendor::Zulu, "21.0.13.1".to_string()),
        ];
        assert_eq!(
            pick_fixed_vendor(&snapshot, 21),
            Some(JavaVendor::Corretto)
        );
        // Данные овендоре без фикса нет — честно возвращаем None, чтобы
        // остаться на кэше, а не качать уязвимую сборку заново.
        let all_vulnerable = vec![
            (JavaVendor::Temurin, "21.0.13+9.0.LTS".to_string()),
            (JavaVendor::Microsoft, "21.0.13.0.2".to_string()),
        ];
        assert_eq!(pick_fixed_vendor(&all_vulnerable, 21), None);
        assert_eq!(pick_fixed_vendor(&[], 21), None);
    }

    #[cfg(unix)]
    #[test]
    fn remove_vulnerable_runtime_keeps_patched_builds() {
        use std::os::unix::fs::PermissionsExt;
        let root = std::env::temp_dir().join(format!(
            "stardust-java-remove-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        // Два рантайма: уязвимый Temurin и уже вылеченный Zulu.
        for (vendor, version) in [(JavaVendor::Temurin, "21.0.13"), (JavaVendor::Zulu, "21.0.13.1")] {
            let runtime = root.join("runtime").join(vendor.id()).join("java-21");
            fs::create_dir_all(runtime.join("bin")).unwrap();
            fs::write(runtime.join(".complete"), b"ok").unwrap();
            let exe = runtime.join("bin/java");
            fs::write(&exe, format!("#!/bin/sh\nprintf 'openjdk version \"{version}\"\\n' >&2\n")).unwrap();
            fs::set_permissions(&exe, fs::Permissions::from_mode(0o755)).unwrap();
        }
        remove_vulnerable_runtime(&root, JavaVendor::Temurin, 21);
        assert!(bundled_runtime_dir(&root, JavaVendor::Temurin, 21).is_none());
        // Вылеченную сборку того же метода не трогаем.
        assert!(!remove_vulnerable_runtime(&root, JavaVendor::Zulu, 21));
        assert!(bundled_runtime_dir(&root, JavaVendor::Zulu, 21).is_some());
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn refresh_removes_every_vulnerable_runtime() {
        use std::os::unix::fs::PermissionsExt;
        let root = std::env::temp_dir().join(format!(
            "stardust-java-refresh-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        // Уязвимые Temurin и Corretto + исправный Zulu, который игра возьмёт.
        for (vendor, version) in [
            (JavaVendor::Temurin, "21.0.13"),
            (JavaVendor::Corretto, "21.0.13"),
            (JavaVendor::Zulu, "21.0.13.1"),
        ] {
            let runtime = root.join("runtime").join(vendor.id()).join("java-21");
            fs::create_dir_all(runtime.join("bin")).unwrap();
            fs::write(runtime.join(".complete"), b"ok").unwrap();
            let exe = runtime.join("bin/java");
            fs::write(&exe, format!("#!/bin/sh\nprintf 'openjdk version \"{version}\"\\n' >&2\n")).unwrap();
            fs::set_permissions(&exe, fs::Permissions::from_mode(0o755)).unwrap();
        }
        // Сети здесь нет — но она и не нужна: исправная сборка уже в кэше,
        // значит фоновая проверка только чистит уязвимые рантаймы.
        assert_eq!(
            drop_stale_vulnerable_runtimes(&root, 21),
            Some(JavaVendor::Temurin)
        );
        assert!(bundled_runtime_dir(&root, JavaVendor::Temurin, 21).is_none());
        assert!(bundled_runtime_dir(&root, JavaVendor::Corretto, 21).is_none());
        assert!(bundled_runtime_dir(&root, JavaVendor::Zulu, 21).is_some());
        fs::remove_dir_all(root).unwrap();
    }

    /// Уязвимый ccache может быть не только Java 21: сборка, требующая 25,
    /// оставляла красный бейдж навсегда, потому что починка смотрела только
    /// на `JAVA_VERSION`.
    #[test]
    fn vulnerable_majors_cover_every_cached_runtime() {
        use std::os::unix::fs::PermissionsExt;
        let root = std::env::temp_dir().join(format!(
            "stardust-java-majors-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        // Corretto 21 уже вылечен, Temurin 25.0.5 — уязвим и живёт в кэше
        // рядом. Недокачанный каталог (без `.complete`) не должен попадать
        // в цели починки.
        for (vendor, major, version, complete) in [
            (JavaVendor::Corretto, 21, "21.0.13.1", true),
            (JavaVendor::Temurin, 25, "25.0.5", true),
            (JavaVendor::Zulu, 25, "25.0.5", false),
        ] {
            let runtime = root.join("runtime").join(vendor.id()).join(format!("java-{major}"));
            fs::create_dir_all(runtime.join("bin")).unwrap();
            if complete {
                fs::write(runtime.join(".complete"), b"ok").unwrap();
            }
            let exe = runtime.join("bin/java");
            fs::write(&exe, format!("#!/bin/sh\nprintf 'openjdk version \"{version}\"\\n' >&2\n")).unwrap();
            fs::set_permissions(&exe, fs::Permissions::from_mode(0o755)).unwrap();
        }
        assert_eq!(vulnerable_cached_majors(&root), vec![25]);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn version_less_handles_patch_respins() {
        assert!(version_less("21.0.13", "21.0.13.1"));
        assert!(version_less("21.0.13+9", "21.0.13.1.2"));
        assert!(!version_less("21.0.13.1", "21.0.13"));
        assert!(!version_less("21.0.13.1.2", "21.0.13.1.2"));
        assert!(version_less("21.0.13", "21.0.14"));
        assert!(!version_less("21.0.14", "21.0.13.1"));
    }

    #[test]
    fn version_from_artifact_reads_vendor_filenames() {
        assert_eq!(
            version_from_artifact("amazon-corretto-21.0.13.1.2-linux-x64.tar.gz").as_deref(),
            Some("21.0.13.1.2")
        );
        assert_eq!(
            version_from_artifact("microsoft-jdk-21.0.13.0.2-macos-aarch64.tar.gz").as_deref(),
            Some("21.0.13.0.2")
        );
        assert_eq!(
            version_from_artifact("OpenJDK21U-jre_x64_linux_hotspot_21.0.13_9.tar.gz").as_deref(),
            Some("21.0.13")
        );
        // `release_name` из Adoptium API: в отличие от `semver`
        // (`21.0.13+100000002.0.LTS`) респин здесь — компонент версии.
        assert_eq!(
            version_from_artifact("jdk-21.0.13.1+2").as_deref(),
            Some("21.0.13.1")
        );
        assert_eq!(
            version_from_artifact("jdk-25.0.5.1+2").as_deref(),
            Some("25.0.5.1")
        );
        assert_eq!(version_from_artifact("latest").as_deref(), None);
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

    /// Path traversal через симлинк: `lib -> ../../..` + файл `lib/evil` —
    /// запись за пределы runtime. Должен быть отказ, а не «распаковали».
    #[test]
    fn extract_java_tar_gz_rejects_symlink_escape() {
        let dir = std::env::temp_dir().join("stardust_test_tar_symlink_escape");
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let target = dir.join("target");
        fs::create_dir_all(&target).unwrap();

        let archive_path = dir.join("evil.tar.gz");
        {
            let file = fs::File::create(&archive_path).unwrap();
            let enc = flate2::write::GzEncoder::new(file, flate2::Compression::default());
            let mut builder = tar::Builder::new(enc);

            let mut link_header = tar::Header::new_gnu();
            link_header.set_path("jdk-21/Contents/Home/lib").unwrap();
            link_header.set_size(0);
            link_header.set_entry_type(tar::EntryType::Symlink);
            link_header.set_link_name("../../..").unwrap();
            link_header.set_cksum();
            builder.append(&link_header, &b""[..]).unwrap();

            builder.into_inner().unwrap().finish().unwrap();
        }

        let result = extract_java_tar_gz(&archive_path, &target);
        assert!(result.is_err(), "Symlink escape должен быть отклонён");
        let err = result.unwrap_err();
        assert!(
            err.contains("Небезопасный симлинк"),
            "Error was: {err}"
        );

        let _ = fs::remove_dir_all(&dir);
    }

    /// Абсолютная цель симлинка — тоже отказ (пишет мимо sandbox).
    #[test]
    fn extract_java_tar_gz_rejects_absolute_symlink() {
        let dir = std::env::temp_dir().join("stardust_test_tar_symlink_abs");
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let target = dir.join("target");
        fs::create_dir_all(&target).unwrap();

        let archive_path = dir.join("evil.tar.gz");
        {
            let file = fs::File::create(&archive_path).unwrap();
            let enc = flate2::write::GzEncoder::new(file, flate2::Compression::default());
            let mut builder = tar::Builder::new(enc);

            let mut link_header = tar::Header::new_gnu();
            link_header.set_path("jdk-21/Contents/Home/lib").unwrap();
            link_header.set_size(0);
            link_header.set_entry_type(tar::EntryType::Symlink);
            link_header.set_link_name("/etc").unwrap();
            link_header.set_cksum();
            builder.append(&link_header, &b""[..]).unwrap();

            builder.into_inner().unwrap().finish().unwrap();
        }

        let result = extract_java_tar_gz(&archive_path, &target);
        assert!(result.is_err(), "Абсолютный симлинк должен быть отклонён");

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn strip_archive_top_level_removes_prefix() {
        assert_eq!(strip_archive_top_level("jdk-21/bin/java"), "bin/java");
        assert_eq!(strip_archive_top_level("java"), "java");
    }
}
