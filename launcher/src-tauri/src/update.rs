// Самообновление лаунчера через GitHub Releases.
//
// Вместо встроенного tauri-plugin-updater (который требует подписывать
// артефакты приватным ключом) лаунчер сам опрашивает GitHub Releases API,
// сравнивает версию и при наличии новой скачивает установщик NSIS
// (`*-setup.exe`) и запускает его. Транспортная безопасность обеспечивается
// HTTPS GitHub; криптоподпись апдейта не используется.
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

/// Запускает скачанный установщик. На прочих платформах не поддержано.
fn launch_installer(path: &std::path::Path) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new(path)
            .spawn()
            .map_err(|e| format!("Не удалось запустить установщик: {e}"))?;
        Ok(())
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = path;
        Err("Автоустановка поддерживается только на Windows".into())
    }
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

/// Скачать доступное обновление и запустить установщик, затем закрыть лаунчер.
///
/// Прогресс скачивания эмитится событием `launcher://update-progress`
/// с долей 0..1 (или null, если общий размер неизвестен).
#[tauri::command]
pub async fn install_update(app: AppHandle) -> Result<(), String> {
    use std::io::Write;
    use tauri::Emitter;

    let release = fetch_latest().await?;
    let asset = pick_asset(&release.assets)
        .ok_or_else(|| "В релизе нет подходящего установщика".to_string())?;

    let mut resp = http_client()?
        .get(&asset.browser_download_url)
        .send()
        .await
        .map_err(|e| format!("Не удалось скачать обновление: {e}"))?;

    if !resp.status().is_success() {
        return Err(format!("Загрузка вернула статус {}", resp.status()));
    }

    let total = resp.content_length();
    let path = std::env::temp_dir().join(&asset.name);
    let mut file = std::fs::File::create(&path)
        .map_err(|e| format!("Не удалось создать файл обновления: {e}"))?;

    let mut downloaded: u64 = 0;
    let _ = app.emit("launcher://update-progress", Some(0.0));
    while let Some(chunk) = resp.chunk().await.map_err(|e| e.to_string())? {
        file.write_all(&chunk).map_err(|e| e.to_string())?;
        downloaded += chunk.len() as u64;
        let fraction = total.map(|t| {
            if t > 0 {
                downloaded as f64 / t as f64
            } else {
                0.0
            }
        });
        let _ = app.emit("launcher://update-progress", fraction);
    }
    file.flush().map_err(|e| e.to_string())?;
    drop(file);

    // Запускаем установщик и закрываем лаунчер, чтобы он мог заменить файлы.
    launch_installer(&path)?;
    app.exit(0);
    Ok(())
}
