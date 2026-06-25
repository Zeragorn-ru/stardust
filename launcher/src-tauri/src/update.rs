// Самообновление лаунчера через tauri-plugin-updater.
//
// Эндпоинт обновлений берётся из переменной окружения `LAUNCHER_UPDATE_URL`
// (как `LAUNCHER_AUTH_URL` для auth-сервера). Если не задана — используется
// значение из `tauri.conf.json` (секция plugins.updater.endpoints).
//
// Подписи проверяются публичным ключом из конфига; собирать обновляемые
// артефакты нужно с приватным ключом (см. README раздел про обновления).

use serde::Serialize;
use tauri::AppHandle;
use tauri_plugin_updater::UpdaterExt;

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

/// Строит updater с учётом переопределения эндпоинта через окружение.
fn build_updater(app: &AppHandle) -> Result<tauri_plugin_updater::Updater, String> {
    let mut builder = app.updater_builder();

    if let Some(url) = std::env::var("LAUNCHER_UPDATE_URL")
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
    {
        let endpoint = url
            .parse()
            .map_err(|e| format!("Некорректный LAUNCHER_UPDATE_URL: {e}"))?;
        builder = builder
            .endpoints(vec![endpoint])
            .map_err(|e| e.to_string())?;
    }

    builder.build().map_err(|e| e.to_string())
}

/// Проверить наличие обновления, ничего не устанавливая.
#[tauri::command]
pub async fn check_update(app: AppHandle) -> Result<UpdateInfo, String> {
    let current_version = app.package_info().version.to_string();
    let updater = build_updater(&app)?;

    match updater.check().await.map_err(|e| e.to_string())? {
        Some(update) => Ok(UpdateInfo {
            available: true,
            current_version,
            version: Some(update.version.clone()),
            notes: update.body.clone(),
        }),
        None => Ok(UpdateInfo {
            available: false,
            current_version,
            version: None,
            notes: None,
        }),
    }
}

/// Скачать и установить доступное обновление, затем перезапустить приложение.
///
/// Прогресс скачивания эмитится событием `launcher://update-progress`
/// с долей 0..1 (или null, если общий размер неизвестен).
#[tauri::command]
pub async fn install_update(app: AppHandle) -> Result<(), String> {
    use tauri::Emitter;

    let updater = build_updater(&app)?;
    let Some(update) = updater.check().await.map_err(|e| e.to_string())? else {
        return Err("Обновлений нет".into());
    };

    let mut downloaded: u64 = 0;
    let app_for_progress = app.clone();

    update
        .download_and_install(
            move |chunk, total| {
                downloaded += chunk as u64;
                let fraction = total.map(|t| {
                    if t > 0 {
                        downloaded as f64 / t as f64
                    } else {
                        0.0
                    }
                });
                let _ = app_for_progress.emit("launcher://update-progress", fraction);
            },
            || {},
        )
        .await
        .map_err(|e| e.to_string())?;

    // После успешной установки перезапускаем лаунчер на новой версии.
    app.restart();
}
