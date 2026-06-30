// Самообновление лаунчера через GitHub Releases.
//
// Вместо встроенного tauri-plugin-updater (который требует подписывать
// артефакты приватным ключом) лаунчер сам опрашивает GitHub Releases API,
// сравнивает версию и при наличии новой скачивает установщик NSIS
// (`*-setup.exe`) и запускает его. Транспортная безопасность обеспечивается
// HTTPS GitHub. Целостность установщика проверяется через SHA-256 (файл
// `*.sha256` рядом с установщиком в релизе).
//
// URL релизного API можно переопределить переменной `LAUNCHER_UPDATE_URL`
// (как `LAUNCHER_AUTH_URL` для auth-сервера). Она должна указывать на JSON
// одного релиза GitHub Releases API (.../releases/latest).

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

/// Эндпоинт GitHub Releases API по умолчанию — список релизов (новые первые).
const RELEASES_API: &str = "https://api.github.com/repos/Zeragorn-ru/stardust/releases";

/// User-Agent обязателен для запросов к GitHub API.
const USER_AGENT: &str = "stardust-launcher-updater";

/// Максимальное количество попыток скачивания.
const MAX_DOWNLOAD_ATTEMPTS: u32 = 3;

/// Начальная задержка между попытками (секунды). Удваивается при каждой попытке.
const INITIAL_BACKOFF_SECS: u64 = 2;

// ─── Payload для Tauri events ────────────────────────────────────────────────

/// Фаза обновления для отображения в UI.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct UpdateProgress {
    /// Текущая фаза: "downloading_bootstrap", "downloading_installer",
    /// "verifying_sha256", "launching", "error".
    phase: String,
    /// Человекочитаемое описание.
    label: String,
    /// Общий прогресс 0..1.
    fraction: Option<f64>,
    /// Сколько байт уже скачано.
    downloaded_bytes: Option<u64>,
    /// Общий размер файла.
    total_bytes: Option<u64>,
    /// Скорость загрузки (байт/сек).
    speed_bytes_per_sec: Option<f64>,
    /// Оставшееся время (секунды).
    eta_seconds: Option<f64>,
}

/// Отправить прогресс обновления во фронтенд.
fn emit_progress(app: &AppHandle, progress: &UpdateProgress) {
    let _ = app.emit("launcher://update-progress", progress);
}

// ─── Модели GitHub API ──────────────────────────────────────────────────────

/// Результат проверки обновлений для фронтенда.
#[derive(Debug, Clone, Serialize)]
pub struct UpdateInfo {
    /// Доступна ли новая версия.
    pub available: bool,
    /// Текущая версия лаунчера.
    #[serde(rename = "currentVersion")]
    pub current_version: String,
    /// Версия обновления (если доступно).
    pub version: Option<String>,
    /// Заметки к релизу (если есть).
    pub notes: Option<String>,
}

/// Минимально необходимые поля релиза из ответа GitHub API.
#[derive(Debug, Deserialize)]
struct GhRelease {
    tag_name: String,
    #[serde(default)]
    body: Option<String>,
    #[serde(default)]
    assets: Vec<GhAsset>,
}

/// Прикреплённый к релизу файл.
#[derive(Debug, Deserialize)]
struct GhAsset {
    name: String,
    browser_download_url: String,
    /// Размер файла в байтах (GitHub API отдаёт поле `size`).
    #[serde(default)]
    size: u64,
}

// ─── Вспомогательные функции ────────────────────────────────────────────────

/// URL релизного API с учётом переопределения через окружение.
fn api_url() -> String {
    std::env::var("LAUNCHER_UPDATE_URL")
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| RELEASES_API.to_string())
}

/// HTTP-клиент с корректным User-Agent для GitHub API.
/// Пробует прокси; при ошибке — прямое соединение.
fn http_client() -> Result<reqwest::Client, String> {
    // Сначала пробуем через прокси.
    if let Ok(client) = reqwest::Client::builder()
        .user_agent(USER_AGENT)
        .proxy(
            reqwest::Proxy::all("http://assets.zeragorn.xyz:3128")
                .map_err(|e| e.to_string())?,
        )
        .connect_timeout(std::time::Duration::from_secs(5))
        .timeout(std::time::Duration::from_secs(15))
        .build()
    {
        return Ok(client);
    }
    // Фоллбэк: прямое соединение без прокси.
    tracing::warn!("[update] прокси недоступен, используем прямое соединение");
    reqwest::Client::builder()
        .user_agent(USER_AGENT)
        .connect_timeout(std::time::Duration::from_secs(5))
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|e| e.to_string())
}

/// Загружает список релизов (новые первые, до 50 штук).
async fn fetch_releases() -> Result<Vec<GhRelease>, String> {
    let resp = http_client()?
        .get(api_url())
        .header("Accept", "application/vnd.github+json")
        .query(&[("per_page", "50")])
        .send()
        .await
        .map_err(|e| format!("Не удалось получить список релизов: {e}"))?;

    if !resp.status().is_success() {
        return Err(format!("GitHub API ответил статусом {}", resp.status()));
    }

    resp.json::<Vec<GhRelease>>()
        .await
        .map_err(|e| format!("Не удалось разобрать список релизов: {e}"))
}

/// Проверяет, есть ли в релизе установщик и bootstrap.exe (обновлятор).
fn is_release_ready(release: &GhRelease) -> bool {
    let has_installer = pick_asset(&release.assets).is_some();
    let has_bootstrap = find_bootstrap_asset(&release.assets).is_some();
    has_installer && has_bootstrap
}

/// Ищет первый релиз, который новее текущей версии и готов к скачиванию
/// (есть установщик + bootstrap.exe). Релизы идут от нового к старому.
async fn find_update_release(current_version: &str) -> Result<Option<GhRelease>, String> {
    let releases = fetch_releases().await?;
    for release in releases {
        let tag = normalize(&release.tag_name);
        if is_newer(tag, current_version) && is_release_ready(&release) {
            return Ok(Some(release));
        }
    }
    Ok(None)
}

/// Убирает из заметок релиза служебные строки GitHub (Full Changelog и т.п.).
fn clean_release_notes(body: Option<String>) -> Option<String> {
    body.and_then(|b| {
        let cleaned: String = b
            .lines()
            .filter(|line| {
                let lower = line.to_lowercase();
                !lower.starts_with("full changelog")
                    && !lower.starts_with("**full changelog**")
                    && !lower.contains("compare/")
            })
            .collect::<Vec<_>>()
            .join("\n")
            .trim()
            .to_string();
        if cleaned.is_empty() {
            None
        } else {
            Some(cleaned)
        }
    })
}

fn normalize(v: &str) -> &str {
    v.trim().trim_start_matches(['v', 'V'])
}

/// Возвращает true, если `latest` строго новее `current`.
/// Сравнение покомпонентно по числам, разделённым точками (semver-подобно).
/// Суффиксы `-rc1`, `-beta` и т.п. игнорируются — `1.2.0-rc1` считается равным `1.2.0`.
fn is_newer(latest: &str, current: &str) -> bool {
    let parse = |s: &str| -> Vec<u64> {
        normalize(s)
            .split('.')
            .map(|p| {
                p.chars()
                    .take_while(|c| c.is_ascii_digit())
                    .collect::<String>()
                    .parse::<u64>()
                    .unwrap_or(0)
            })
            .collect()
    };
    let a = parse(latest);
    let b = parse(current);
    for i in 0..a.len().max(b.len()) {
        let x = a.get(i).copied().unwrap_or(0);
        let y = b.get(i).copied().unwrap_or(0);
        if x != y {
            return x > y;
        }
    }
    false
}

/// Выбирает подходящий установщик для текущей платформы.
fn pick_asset(assets: &[GhAsset]) -> Option<&GhAsset> {
    #[cfg(target_os = "windows")]
    {
        assets
            .iter()
            .find(|a| a.name.to_lowercase().ends_with("-setup.exe"))
            .or_else(|| {
                assets
                    .iter()
                    .find(|a| a.name.to_lowercase().ends_with(".msi"))
            })
    }
    #[cfg(not(target_os = "windows"))]
    {
        assets.iter().find(|a| {
            let n = a.name.to_lowercase();
            n.ends_with(".appimage") || n.ends_with(".dmg")
        })
    }
}

/// Ищет SHA-256 хеш для given installer name в ассетах релиза.
fn find_sha256_asset<'a>(assets: &'a [GhAsset], installer_name: &str) -> Option<&'a GhAsset> {
    let sha256_name = format!("{installer_name}.sha256");
    assets.iter().find(|a| a.name == sha256_name)
}

/// Скачивает и парсит содержимое .sha256 файла, возвращая hex-строку хеша.
async fn fetch_expected_sha256(http: &reqwest::Client, url: &str) -> Result<String, String> {
    let text = http
        .get(url)
        .send()
        .await
        .map_err(|e| format!("Не удалось скачать .sha256: {e}"))?
        .error_for_status()
        .map_err(|e| format!("Ошибка скачивания .sha256: {e}"))?
        .text()
        .await
        .map_err(|e| format!("Не удалось прочитать .sha256: {e}"))?;

    let hex = text
        .split_whitespace()
        .next()
        .filter(|h| h.len() == 64 && h.chars().all(|c| c.is_ascii_hexdigit()))
        .map(|h| h.to_lowercase())
        .ok_or_else(|| format!("Некорректный формат .sha256: {text}"))?;
    Ok(hex)
}

/// Вычисляет SHA-256 файла и возвращает hex-строку.
fn compute_sha256(path: &std::path::Path) -> Result<String, String> {
    crate::sha256::compute_sha256_file(path)
}

/// Безопасно извлекает basename файла, отвергая пути с traversal.
fn sanitize_filename(name: &str) -> Result<String, String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("Имя файла пустое".into());
    }
    if name.contains(['/', '\\']) || name == ".." || name.starts_with("..") || name.contains("..")
    {
        return Err(format!("Подозрительное имя файла: {name}"));
    }
    let basename = std::path::Path::new(name)
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| format!("Некорректное имя файла: {name}"))?;
    Ok(basename.to_string())
}

/// Ищет bootstrap.exe в ассетах релиза.
fn find_bootstrap_asset(assets: &[GhAsset]) -> Option<&GhAsset> {
    assets
        .iter()
        .find(|a| a.name.to_lowercase() == "bootstrap.exe")
}

// ─── Скачивание с прогрессом и retry ────────────────────────────────────────

/// Параметры скачивания для передачи между функциями.
struct DownloadParams<'a> {
    app: &'a AppHandle,
    http: &'a reqwest::Client,
    url: &'a str,
    path: &'a std::path::Path,
    phase_name: &'a str,
    fraction_start: f64,
    fraction_end: f64,
    total_size: u64,
    progress_name: &'a str,
}

/// Скачивает файл из релиза во временную директорию с прогрессом и retry.
#[allow(clippy::too_many_arguments)]
async fn download_asset_with_progress(
    app: &AppHandle,
    http: &reqwest::Client,
    asset: &GhAsset,
    progress_name: &str,
    phase_name: &str,
    fraction_start: f64,
    fraction_end: f64,
    total_size: u64,
) -> Result<std::path::PathBuf, String> {
    let safe_name = sanitize_filename(&asset.name)?;
    let path = std::env::temp_dir().join(&safe_name);

    let params = DownloadParams {
        app,
        http,
        url: &asset.browser_download_url,
        path: &path,
        phase_name,
        fraction_start,
        fraction_end,
        total_size,
        progress_name,
    };

    let mut last_err = String::new();

    for attempt in 1..=MAX_DOWNLOAD_ATTEMPTS {
        if attempt > 1 {
            let backoff = INITIAL_BACKOFF_SECS * 2u64.pow(attempt - 2);
            tracing::info!(
                "[update] попытка {attempt}/{MAX_DOWNLOAD_ATTEMPTS} для {progress_name} (ожидание {backoff}с)"
            );
            emit_progress(
                app,
                &UpdateProgress {
                    phase: phase_name.into(),
                    label: format!("Повтор {attempt}/{MAX_DOWNLOAD_ATTEMPTS}…"),
                    fraction: Some(fraction_start),
                    downloaded_bytes: None,
                    total_bytes: if total_size > 0 { Some(total_size) } else { None },
                    speed_bytes_per_sec: None,
                    eta_seconds: None,
                },
            );
            tokio::time::sleep(std::time::Duration::from_secs(backoff)).await;
        }

        match download_single(&params).await {
            Ok(()) => return Ok(path),
            Err(e) => {
                tracing::warn!("[update] ошибка скачивания {progress_name} (попытка {attempt}): {e}");
                last_err = e;
            }
        }
    }

    Err(format!(
        "Не удалось скачать {progress_name} после {MAX_DOWNLOAD_ATTEMPTS} попыток: {last_err}"
    ))
}

/// Одна попытка скачивания файла с прогрессом.
async fn download_single(params: &DownloadParams<'_>) -> Result<(), String> {
    use std::io::Write;

    let mut resp = params
        .http
        .get(params.url)
        .send()
        .await
        .map_err(|e| format!("Не удалось скачать {}: {e}", params.progress_name))?;

    if !resp.status().is_success() {
        return Err(format!(
            "{}: загрузка вернула статус {}",
            params.progress_name,
            resp.status()
        ));
    }

    let content_length = resp.content_length().unwrap_or(params.total_size);

    let mut file = std::fs::File::create(params.path)
        .map_err(|e| format!("Не удалось создать файл {}: {e}", params.progress_name))?;

    let mut downloaded: u64 = 0;
    let start = std::time::Instant::now();
    let mut last_emit = std::time::Instant::now();

    while let Some(chunk) = resp.chunk().await.map_err(|e| e.to_string())? {
        file.write_all(&chunk).map_err(|e| e.to_string())?;
        downloaded += chunk.len() as u64;

        if last_emit.elapsed() >= std::time::Duration::from_millis(250) {
            let elapsed = start.elapsed().as_secs_f64();
            let speed = if elapsed > 0.0 {
                downloaded as f64 / elapsed
            } else {
                0.0
            };
            let fraction = if content_length > 0 {
                let raw = params.fraction_start
                    + (downloaded as f64 / content_length as f64)
                        * (params.fraction_end - params.fraction_start);
                // Защита от NaN/Inf — шлём None если что-то пошло не так.
                if raw.is_finite() { raw } else { params.fraction_start }
            } else {
                params.fraction_start
            };
            let eta = if speed > 0.0 && content_length > downloaded {
                Some((content_length - downloaded) as f64 / speed)
            } else {
                None
            };

            emit_progress(
                params.app,
                &UpdateProgress {
                    phase: params.phase_name.into(),
                    label: format!("Скачивание {}…", params.progress_name),
                    fraction: Some(fraction),
                    downloaded_bytes: Some(downloaded),
                    total_bytes: if content_length > 0 {
                        Some(content_length)
                    } else {
                        None
                    },
                    speed_bytes_per_sec: Some(speed),
                    eta_seconds: eta,
                },
            );
            last_emit = std::time::Instant::now();
        }
    }

    file.flush().map_err(|e| e.to_string())?;

    tracing::info!(
        "[update] {} скачан: {downloaded} байт за {:.1}с",
        params.progress_name,
        start.elapsed().as_secs_f64()
    );

    Ok(())
}

// ─── Запуск bootstrap ───────────────────────────────────────────────────────

/// Запускает bootstrap.exe с установщиком, каталогом установки и именем exe.
#[cfg(target_os = "windows")]
fn launch_bootstrap(
    bootstrap_path: &std::path::Path,
    installer_path: &std::path::Path,
    install_dir: &std::path::Path,
) -> Result<(), String> {
    // Передаём имя текущего exe, чтобы bootstrap знал как называется бинарник.
    let exe_name = std::env::current_exe()
        .ok()
        .and_then(|p| p.file_name().map(|n| n.to_owned()))
        .unwrap_or_else(|| std::ffi::OsString::from("launcher.exe"));

    use std::os::windows::process::CommandExt;
    std::process::Command::new(bootstrap_path)
        .arg(installer_path)
        .arg(install_dir)
        .arg(exe_name)
        .creation_flags(0x0800_0000) // CREATE_NO_WINDOW
        .spawn()
        .map_err(|e| format!("Не удалось запустить обновлятор: {e}"))?;
    Ok(())
}

#[cfg(not(target_os = "windows"))]
fn launch_bootstrap(
    _bootstrap_path: &std::path::Path,
    _installer_path: &std::path::Path,
    _install_dir: &std::path::Path,
) -> Result<(), String> {
    Err("Обновление поддерживается только на Windows".into())
}

// ─── Tauri commands ─────────────────────────────────────────────────────────

/// Проверить наличие обновления, ничего не устанавливая.
#[tauri::command]
pub async fn check_update(app: AppHandle) -> Result<UpdateInfo, String> {
    let current_version = app.package_info().version.to_string();
    match find_update_release(&current_version).await? {
        Some(release) => {
            let version = normalize(&release.tag_name).to_string();
            Ok(UpdateInfo {
                available: true,
                current_version,
                version: Some(version),
                notes: clean_release_notes(release.body),
            })
        }
        None => Ok(UpdateInfo {
            available: false,
            current_version,
            version: None,
            notes: None,
        }),
    }
}

/// Скачать доступное обновление и запустить обновлятор, затем закрыть лаунчер.
///
/// Фазы с прогрессом:
/// 1. downloading_bootstrap  (0.00 — 0.30)
/// 2. downloading_installer  (0.30 — 0.85)
/// 3. verifying_sha256       (0.85 — 0.95)
/// 4. launching              (0.95 — 1.00)
#[tauri::command]
pub async fn install_update(app: AppHandle) -> Result<(), String> {
    let current_version = app.package_info().version.to_string();
    let release = find_update_release(&current_version)
        .await?
        .ok_or_else(|| "Нет доступного обновления".to_string())?;

    let installer_asset = pick_asset(&release.assets)
        .ok_or_else(|| "В релизе нет подходящего установщика".to_string())?;
    let installer_size = installer_asset.size;

    let http = http_client()?;

    // ── Фаза 1: bootstrap (0.00 — 0.30) ──────────────────────────────────
    let _data_dir = crate::paths::data_dir(&app);

    let bootstrap_asset = find_bootstrap_asset(&release.assets)
        .ok_or_else(|| "В релизе нет bootstrap.exe".to_string())?;
    let bootstrap_path = download_asset_with_progress(
        &app,
        &http,
        bootstrap_asset,
        "bootstrap.exe",
        "downloading_bootstrap",
        0.0,
        0.30,
        bootstrap_asset.size,
    )
    .await?;

    // ── Фаза 2: установщик (0.30 — 0.85) ─────────────────────────────────
    let installer_path = download_asset_with_progress(
        &app,
        &http,
        installer_asset,
        &installer_asset.name,
        "downloading_installer",
        0.30,
        0.85,
        installer_size,
    )
    .await?;

    // ── Фаза 3: SHA-256 верификация (0.85 — 0.95) ────────────────────────
    emit_progress(
        &app,
        &UpdateProgress {
            phase: "verifying_sha256".into(),
            label: "Проверка целостности файла…".into(),
            fraction: Some(0.85),
            downloaded_bytes: None,
            total_bytes: None,
            speed_bytes_per_sec: None,
            eta_seconds: None,
        },
    );

    let sha256_asset = find_sha256_asset(&release.assets, &installer_asset.name);
    match sha256_asset {
        Some(sha256_a) => {
            let expected = fetch_expected_sha256(&http, &sha256_a.browser_download_url).await;
            match expected {
                Ok(expected_hex) => {
                    let actual = tauri::async_runtime::spawn_blocking({
                        let p = installer_path.clone();
                        move || compute_sha256(&p)
                    })
                    .await
                    .map_err(|e| format!("Ошибка потока SHA-256: {e}"))?;
                    match actual {
                        Ok(actual_hex) if actual_hex == expected_hex => {
                            tracing::debug!("[update] SHA-256 OK");
                        }
                        Ok(_mismatched_hex) => {
                            let _ = std::fs::remove_file(&installer_path);
                            return Err(
                                "Повреждён файл установщика (SHA-256 не совпал). Скачайте заново."
                                    .to_string(),
                            );
                        }
                        Err(e) => {
                            let _ = std::fs::remove_file(&installer_path);
                            return Err(format!("Не удалось проверить файл: {e}"));
                        }
                    }
                }
                Err(e) => {
                    tracing::warn!(
                        "[update] предупреждение: не удалось проверить SHA-256 ({e}), продолжаем без верификации"
                    );
                }
            }
        }
        None => {
            tracing::warn!("[update] предупреждение: .sha256 файл не найден в релизе, продолжаем без верификации хеша");
        }
    }

    // ── Фаза 4: запуск (0.95 — 1.00) ─────────────────────────────────────
    emit_progress(
        &app,
        &UpdateProgress {
            phase: "launching".into(),
            label: "Запуск обновления…".into(),
            fraction: Some(0.95),
            downloaded_bytes: None,
            total_bytes: None,
            speed_bytes_per_sec: None,
            eta_seconds: None,
        },
    );

    let install_dir = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|p| p.to_path_buf()))
        .unwrap_or_else(std::env::temp_dir);

    launch_bootstrap(&bootstrap_path, &installer_path, &install_dir)?;

    emit_progress(
        &app,
        &UpdateProgress {
            phase: "launching".into(),
            label: "Обновление запущено. Лаунчер закроется…".into(),
            fraction: Some(1.0),
            downloaded_bytes: None,
            total_bytes: None,
            speed_bytes_per_sec: None,
            eta_seconds: None,
        },
    );

    tokio::time::sleep(std::time::Duration::from_millis(800)).await;
    app.exit(0);
    Ok(())
}

// ─── Tests ──────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_strips_v_prefix() {
        assert_eq!(normalize("v1.2.3"), "1.2.3");
        assert_eq!(normalize("V2.0.0"), "2.0.0");
        assert_eq!(normalize("1.0.0"), "1.0.0");
        assert_eq!(normalize("  v3.1.4  "), "3.1.4");
    }

    #[test]
    fn is_newer_basic() {
        assert!(is_newer("1.2.0", "1.1.0"));
        assert!(is_newer("2.0.0", "1.9.9"));
        assert!(is_newer("1.0.1", "1.0.0"));
        assert!(!is_newer("1.0.0", "1.0.0"));
        assert!(!is_newer("1.0.0", "1.1.0"));
        assert!(!is_newer("1.1.0", "1.2.0"));
    }

    #[test]
    fn is_newer_ignores_prerelease_suffix() {
        assert!(!is_newer("1.2.0-rc1", "1.2.0"));
        assert!(!is_newer("1.2.0-beta", "1.2.0"));
        assert!(!is_newer("1.2.0", "1.2.0-rc1"));
        assert!(is_newer("1.2.1-rc1", "1.2.0"));
    }

    #[test]
    fn is_newer_handles_different_lengths() {
        assert!(is_newer("1.2.3.4", "1.2.3"));
        assert!(!is_newer("1.2.3", "1.2.3.4"));
        assert!(is_newer("10.0", "9.9.9"));
    }

    #[test]
    fn sanitize_filename_valid() {
        assert_eq!(
            sanitize_filename("stardust-setup.exe").unwrap(),
            "stardust-setup.exe"
        );
        assert_eq!(
            sanitize_filename("launcher-1.2.3.msi").unwrap(),
            "launcher-1.2.3.msi"
        );
    }

    #[test]
    fn sanitize_filename_rejects_traversal() {
        assert!(sanitize_filename("../../../etc/passwd").is_err());
        assert!(sanitize_filename("..\\windows\\system32").is_err());
        assert!(sanitize_filename("foo/../bar").is_err());
        assert!(sanitize_filename("foo\\bar").is_err());
    }

    #[test]
    fn sanitize_filename_rejects_empty() {
        assert!(sanitize_filename("").is_err());
        assert!(sanitize_filename("   ").is_err());
    }

    #[test]
    fn sanitize_filename_rejects_dotdot() {
        assert!(sanitize_filename("..").is_err());
    }

    #[test]
    fn compute_sha256_empty_file() {
        let dir = std::env::temp_dir().join("stardust_test_sha256");
        let _ = std::fs::create_dir_all(&dir);
        let path = dir.join("empty.bin");
        std::fs::write(&path, b"").unwrap();
        let hash = compute_sha256(&path).unwrap();
        assert_eq!(
            hash,
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn compute_sha256_known_input() {
        let dir = std::env::temp_dir().join("stardust_test_sha256_2");
        let _ = std::fs::create_dir_all(&dir);
        let path = dir.join("hello.bin");
        std::fs::write(&path, b"hello world").unwrap();
        let hash = compute_sha256(&path).unwrap();
        assert_eq!(
            hash,
            "b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn find_sha256_asset_present() {
        let assets = vec![
            GhAsset {
                name: "setup.exe".into(),
                browser_download_url: "".into(),
                size: 0,
            },
            GhAsset {
                name: "setup.exe.sha256".into(),
                browser_download_url: "https://example.com/sha".into(),
                size: 0,
            },
        ];
        let found = find_sha256_asset(&assets, "setup.exe");
        assert!(found.is_some());
        assert_eq!(found.unwrap().name, "setup.exe.sha256");
    }

    #[test]
    fn find_sha256_asset_absent() {
        let assets = vec![GhAsset {
            name: "setup.exe".into(),
            browser_download_url: "".into(),
            size: 0,
        }];
        assert!(find_sha256_asset(&assets, "setup.exe").is_none());
    }
}
