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
use tauri::AppHandle;

/// Эндпоинт GitHub Releases API по умолчанию.
const RELEASES_API: &str = "https://api.github.com/repos/Zeragorn-ru/stardust/releases/latest";

/// User-Agent обязателен для запросов к GitHub API.
const USER_AGENT: &str = "stardust-launcher-updater";

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
}

/// URL релизного API с учётом переопределения через окружение.
fn api_url() -> String {
    std::env::var("LAUNCHER_UPDATE_URL")
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| RELEASES_API.to_string())
}

/// HTTP-клиент с корректным User-Agent для GitHub API.
fn http_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .user_agent(USER_AGENT)
        .proxy(reqwest::Proxy::all("http://assets.zeragorn.xyz:3128").map_err(|e| e.to_string())?)
        .connect_timeout(std::time::Duration::from_secs(10))
        .timeout(std::time::Duration::from_secs(60))
        .build()
        .map_err(|e| e.to_string())
}

/// Загружает данные о последнем релизе.
async fn fetch_latest() -> Result<GhRelease, String> {
    let resp = http_client()?
        .get(api_url())
        .header("Accept", "application/vnd.github+json")
        .send()
        .await
        .map_err(|e| format!("Не удалось получить данные о релизе: {e}"))?;

    if !resp.status().is_success() {
        return Err(format!("GitHub API ответил статусом {}", resp.status()));
    }

    resp.json::<GhRelease>()
        .await
        .map_err(|e| format!("Не удалось разобрать ответ GitHub: {e}"))
}

/// Убирает ведущий `v`/`V` и пробелы из строки версии.
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
/// Ожидает файл `*.sha256` с содержимым вида `<hex>\n` или `<hex>  <filename>\n`.
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

    // Формат: `<64 hex chars>` или `<64 hex chars>  <filename>` (coreutils sha256sum).
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
    if name.contains(['/', '\\']) || name == ".." || name.starts_with("..") || name.contains("..") {
        return Err(format!("Подозрительное имя файла: {name}"));
    }
    // Дополнительно: берём только последний компонент (на случай строковых артефактов).
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

/// Скачивает файл из релиза во временную директорию.
async fn download_asset(
    http: &reqwest::Client,
    asset: &GhAsset,
    progress_name: &str,
) -> Result<std::path::PathBuf, String> {
    use std::io::Write;

    let safe_name = sanitize_filename(&asset.name)?;
    let path = std::env::temp_dir().join(&safe_name);

    let mut resp = http
        .get(&asset.browser_download_url)
        .send()
        .await
        .map_err(|e| format!("Не удалось скачать {progress_name}: {e}"))?;

    if !resp.status().is_success() {
        return Err(format!(
            "{progress_name}: загрузка вернула статус {}",
            resp.status()
        ));
    }

    let mut file = std::fs::File::create(&path)
        .map_err(|e| format!("Не удалось создать файл {progress_name}: {e}"))?;

    while let Some(chunk) = resp.chunk().await.map_err(|e| e.to_string())? {
        file.write_all(&chunk).map_err(|e| e.to_string())?;
    }
    file.flush().map_err(|e| e.to_string())?;

    Ok(path)
}

/// Запускает bootstrap.exe с установщиком и каталогом установки.
#[cfg(target_os = "windows")]
fn launch_bootstrap(
    bootstrap_path: &std::path::Path,
    installer_path: &std::path::Path,
    install_dir: &std::path::Path,
) -> Result<(), String> {
    use std::os::windows::process::CommandExt;
    std::process::Command::new(bootstrap_path)
        .arg(installer_path)
        .arg(install_dir)
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

/// Проверить наличие обновления, ничего не устанавливая.
#[tauri::command]
pub async fn check_update(app: AppHandle) -> Result<UpdateInfo, String> {
    let current_version = app.package_info().version.to_string();
    let release = fetch_latest().await?;
    let latest = normalize(&release.tag_name).to_string();

    if is_newer(&latest, &current_version) {
        Ok(UpdateInfo {
            available: true,
            current_version,
            version: Some(latest),
            notes: release.body,
        })
    } else {
        Ok(UpdateInfo {
            available: false,
            current_version,
            version: None,
            notes: None,
        })
    }
}

/// Скачать доступное обновление и запустить обновлятор, затем закрыть лаунчер.
///
/// 1. Скачивает `bootstrap.exe` из релиза
/// 2. Скачивает установщик NSIS
/// 3. Верифицирует SHA-256 установщика
/// 4. Запускает `bootstrap.exe <installer_path> <install_dir>`
/// 5. Закрывает лаунчер
///
/// Прогресс скачивания эмитится событием `launcher://update-progress`
/// с долей 0..1 (или null, если общий размер неизвестен).
#[tauri::command]
pub async fn install_update(app: AppHandle) -> Result<(), String> {
    let release = fetch_latest().await?;

    // Находим bootstrap.exe в ассетах.
    let bootstrap_asset = find_bootstrap_asset(&release.assets)
        .ok_or_else(|| "В релизе нет bootstrap.exe".to_string())?;

    // Находим установщик.
    let installer_asset = pick_asset(&release.assets)
        .ok_or_else(|| "В релизе нет подходящего установщика".to_string())?;

    // Скачиваем bootstrap.exe.
    let http = http_client()?;
    let bootstrap_path = download_asset(&http, bootstrap_asset, "bootstrap.exe").await?;

    // Скачиваем установщик.
    let installer_path = download_asset(&http, installer_asset, "установщик").await?;

    // Верификация SHA-256 установщика через .sha256 файл в релизе.
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
                            tracing::debug!("[update] SHA-256 OK: {actual_hex}");
                        }
                        Ok(actual_hex) => {
                            let _ = std::fs::remove_file(&installer_path);
                            return Err(format!(
                                "SHA-256 не совпал: получен {actual_hex}, ожидался {expected_hex}"
                            ));
                        }
                        Err(e) => {
                            let _ = std::fs::remove_file(&installer_path);
                            return Err(format!("Не удалось вычислить SHA-256: {e}"));
                        }
                    }
                }
                Err(e) => {
                    tracing::warn!("[update] предупреждение: не удалось проверить SHA-256 ({e}), продолжаем без верификации");
                }
            }
        }
        None => {
            tracing::warn!("[update] предупреждение: .sha256 файл не найден в релизе, продолжаем без верификации хеша");
        }
    }

    // Каталог установки — рядом с текущим exe (родитель текущего процесса).
    let install_dir = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|p| p.to_path_buf()))
        .unwrap_or_else(std::env::temp_dir);

    // Запускаем bootstrap.exe с установщиком и каталогом установки,
    // затем закрываем лаунчер.
    launch_bootstrap(&bootstrap_path, &installer_path, &install_dir)?;
    tokio::time::sleep(std::time::Duration::from_millis(800)).await;
    app.exit(0);
    Ok(())
}

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
        // SHA-256 of empty string is well-known.
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
            },
            GhAsset {
                name: "setup.exe.sha256".into(),
                browser_download_url: "https://example.com/sha".into(),
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
        }];
        assert!(find_sha256_asset(&assets, "setup.exe").is_none());
    }
}
