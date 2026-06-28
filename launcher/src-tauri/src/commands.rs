// Tauri-команды лаунчера.
//
// Сессия и часть состояния держатся в памяти; настройки пишутся в папку
// данных (портативную или системную — см. модуль `paths`). Скины хранятся
// на auth-сервере и привязаны к аккаунту, а не к устройству.

use std::process::Child;
use std::sync::Mutex;
use tauri::Manager;

use base64::Engine;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, State};

use protocol::PlayerProfile;

use crate::backend;
use crate::minecraft;
use crate::paths;

/// Настройки лаунчера, сохраняемые между запусками.
///
/// Папку игры намеренно не храним: каталог принадлежит лаунчеру и
/// вычисляется автоматически (portable: рядом с exe, installed: appdata).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Settings {
    /// Выделяемая память JVM, МБ.
    #[serde(rename = "memoryMb")]
    pub memory_mb: u32,
    /// Сколько файлов качать одновременно (библиотеки, ассеты, моды).
    /// Значение ограничивается разумным диапазоном при запуске.
    #[serde(rename = "downloadConcurrency", default = "default_concurrency")]
    pub download_concurrency: u32,
}

/// Дефолт параллельности загрузок: подбираем по числу ядер, но в безопасных
/// границах, чтобы не открыть слишком много соединений к серверам Mojang.
fn default_concurrency() -> u32 {
    std::thread::available_parallelism()
        .map(|n| n.get() as u32)
        .unwrap_or(4)
        .clamp(1, 16)
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            memory_mb: 4096,
            download_concurrency: default_concurrency(),
        }
    }
}

/// Сведения о среде запуска для отображения в настройках.
#[derive(Debug, Clone, Serialize)]
pub struct AppInfo {
    /// "portable" | "installed".
    pub mode: String,
    /// Абсолютный путь к папке, где лежит исполняемый файл.
    #[serde(rename = "exeDir")]
    pub exe_dir: String,
    /// Найден ли рядом с exe маркер `portable.txt`/`.portable`.
    #[serde(rename = "portableMarker")]
    pub portable_marker: bool,
    /// Абсолютный путь к папке данных лаунчера.
    #[serde(rename = "dataDir")]
    pub data_dir: String,
    /// Версия лаунчера.
    pub version: String,
}

/// Скин игрока: data-URL PNG + тип модели.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Skin {
    /// `data:image/png;base64,...` или null, если скин не задан.
    #[serde(rename = "dataUrl")]
    pub data_url: Option<String>,
    /// Модель: "classic" (4px руки) или "slim" (3px руки).
    pub model: String,
    /// data-URL PNG плаща или null, если плащ не задан.
    #[serde(rename = "capeUrl")]
    pub cape_url: Option<String>,
    /// UUID лицензии-источника, если скин синхронизируется с Mojang.
    /// null — скин загружен файлом.
    pub source: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct SavedSession {
    profile: PlayerProfile,
    token: String,
}

/// Результат входа, отдаваемый фронтенду.
///
/// Зеркалит `protocol::LoginResult`, но `Ok`-ветка несёт уже сам профиль
/// (токен оседает в runtime/`session.json` и наружу не выходит). При
/// `twoFactorRequired` UI показывает поле ввода кода и затем зовёт `login_2fa`
/// с тем же `challenge`.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "status", rename_all = "camelCase")]
enum LoginOutcome {
    Ok {
        profile: PlayerProfile,
    },
    TwoFactorRequired {
        challenge: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        hint: Option<String>,
        /// Можно ли подтвердить вход кнопкой в Telegram (без ввода кода).
        /// Тогда фронтенд опрашивает соответствующий `*_status`-эндпоинт.
        #[serde(rename = "buttonApproval")]
        button_approval: bool,
    },
}

/// Результат опроса кнопочного подтверждения, отдаваемый фронтенду.
///
/// Зеркалит `protocol::ChallengeStatus`, но для сценариев входа `approved`
/// несёт уже сам профиль (токен оседает в сессии и наружу не выходит). Для
/// сброса пароля `approved` приходит без профиля (`profile: None`) — лаунчер
/// должен показать форму нового пароля и вызвать `password_reset_confirm`.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "status", rename_all = "camelCase")]
enum ChallengeOutcome {
    /// Пользователь ещё не ответил — продолжать опрос.
    Pending,
    /// Подтверждено кнопкой «Это я».
    Approved {
        #[serde(skip_serializing_if = "Option::is_none")]
        profile: Option<PlayerProfile>,
    },
    /// Отклонено кнопкой «Это не я».
    Denied,
    /// Истёк срок или challenge не найден — начать заново.
    Expired,
}

/// Состояние приложения, разделяемое между командами.
pub struct AppState {
    pub profile: Mutex<Option<PlayerProfile>>,
    /// Bearer-токен текущей API-сессии. Сейчас сохраняется в `session.json`
    /// для автологина; когда появятся refresh-токены, заменим схему на более
    /// безопасную долгую сессию.
    pub token: Mutex<Option<String>>,
    /// HTTP-клиент к auth-серверу (переиспользуется между запросами).
    pub http: reqwest::Client,
    /// Запущенный процесс игры, если он есть. Не даём запустить вторую копию,
    /// пока предыдущая не завершилась.
    pub game: Mutex<Option<Child>>,
    /// Асинхронный лок на весь цикл play_game: guard → check → launch → record.
    /// Гарантирует, что два одновременных вызова не пройдут проверку параллельно.
    pub launch_lock: tokio::sync::Mutex<()>,
}

impl Default for AppState {
    fn default() -> Self {
        let http = reqwest::Client::builder()
            .user_agent(concat!("launcher/", env!("CARGO_PKG_VERSION")))
            .proxy(
                reqwest::Proxy::all("http://assets.zeragorn.xyz:3128")
                    .expect("прокси URL невалиден"),
            )
            .connect_timeout(std::time::Duration::from_secs(10))
            .timeout(std::time::Duration::from_secs(30))
            .build()
            .expect("не удалось создать HTTP-клиент");
        Self {
            profile: Mutex::new(None),
            token: Mutex::new(None),
            http,
            game: Mutex::new(None),
            launch_lock: tokio::sync::Mutex::new(()),
        }
    }
}

// ---------- Настройки (персист на диск) ----------

fn read_settings(app: &AppHandle) -> Settings {
    let path = paths::settings_file(app);
    match std::fs::read_to_string(&path) {
        Ok(s) => match serde_json::from_str(&s) {
            Ok(settings) => settings,
            Err(e) => {
                tracing::warn!("[settings] ошибка парсинга {}: {e}, используются значения по умолчанию", path.display());
                Settings::default()
            }
        },
        Err(e) => {
            if e.kind() != std::io::ErrorKind::NotFound {
                tracing::warn!("[settings] не удалось прочитать {}: {e}, используются значения по умолчанию", path.display());
            }
            Settings::default()
        }
    }
}

fn write_settings(app: &AppHandle, settings: &Settings) -> Result<(), String> {
    let path = paths::settings_file(app);
    let json = serde_json::to_string_pretty(settings).map_err(|e| e.to_string())?;
    std::fs::write(&path, json).map_err(|e| e.to_string())
}

fn read_saved_session(app: &AppHandle) -> Option<SavedSession> {
    std::fs::read_to_string(paths::session_file(app))
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
}

fn write_saved_session(app: &AppHandle, session: &SavedSession) -> Result<(), String> {
    let json = serde_json::to_string_pretty(session).map_err(|e| e.to_string())?;
    std::fs::write(paths::session_file(app), json).map_err(|e| e.to_string())
}

fn remove_saved_session(app: &AppHandle) {
    let _ = std::fs::remove_file(paths::session_file(app));
}

fn set_runtime_session(state: &State<AppState>, profile: PlayerProfile, token: String) {
    *state.profile.lock().unwrap() = Some(profile);
    *state.token.lock().unwrap() = Some(token);
}

fn clear_runtime_session(state: &State<AppState>) {
    *state.token.lock().unwrap() = None;
    *state.profile.lock().unwrap() = None;
}

/// Сохраняет сессию и на диск (для автологина), и в runtime-состояние.
fn persist_session(
    state: &State<AppState>,
    app: &AppHandle,
    profile: PlayerProfile,
    token: String,
) -> Result<(), String> {
    write_saved_session(
        app,
        &SavedSession {
            profile: profile.clone(),
            token: token.clone(),
        },
    )?;
    set_runtime_session(state, profile, token);
    Ok(())
}

/// Инициализация локальной папки данных при старте приложения.
///
/// Создаёт `data/`/AppData-папку и дефолтный `settings.json`, чтобы режим
/// хранения был явно виден сразу после запуска. `session.json` создаётся
/// только после успешного входа/регистрации.
/// Переносит данные из старой папки AppData (com.project.launcher)
/// в новую (com.stardust.launcher) если старая существует, а новая — нет.
fn migrate_appdata(app: &AppHandle) {
    // Новая папка берётся через Tauri (identifier = com.stardust.launcher).
    let new_dir = match app.path().app_data_dir() {
        Ok(p) => p,
        Err(_) => return,
    };
    // Старая папка — сосед в %APPDATA% с прежним именем.
    let old_dir = match new_dir.parent() {
        Some(p) => p.join("com.project.launcher"),
        None => return,
    };
    if old_dir.exists() && !new_dir.exists() {
        if let Err(e) = std::fs::rename(&old_dir, &new_dir) {
            tracing::warn!("appdata migration failed: {e}");
        } else {
            tracing::info!("appdata migrated: {} -> {}", old_dir.display(), new_dir.display());
        }
    }
}

pub fn bootstrap(app: &AppHandle) -> Result<(), String> {
    migrate_appdata(app);
    let settings_path = paths::settings_file(app);
    if !settings_path.exists() {
        write_settings(app, &Settings::default())?;
    }
    Ok(())
}

/// Если при прошлом запуске лаунчер закрылся пока игра работала,
/// `game_session.json` остался на диске. Восстанавливаем сессию:
/// если PID уже мёртв — записываем статистику и чистим файл.
///
/// Вызывать только после того, как токен уже загружен в `AppState`.
fn recover_pending_session(app: &AppHandle, state: &AppState) {
    let data_dir = paths::data_dir(app);
    let Some(pending) = crate::game_guard::read_session(&data_dir) else {
        return;
    };
    // Если игра всё ещё жива — ничего не делаем, spawn в play_game досчитает.
    if crate::game_guard::is_running(&data_dir) {
        return;
    }
    let token = match state.token.lock().unwrap().clone() {
        Some(t) => t,
        None => {
            crate::game_guard::clear_session(&data_dir);
            return;
        }
    };
    let http = state.http.clone();
    let launched_at_str = pending.launched_at.clone();
    tauri::async_runtime::spawn(async move {
        let duration = time::OffsetDateTime::parse(
            &launched_at_str,
            &time::format_description::well_known::Rfc3339,
        )
        .map(|t| (time::OffsetDateTime::now_utc() - t).whole_seconds().max(0))
        .unwrap_or(0);
        crate::game_guard::clear_session(&data_dir);
        if duration > 0 {
            if let Err(e) =
                backend::record_session(&http, &token, duration, &launched_at_str).await
            {
                tracing::warn!("[stats] восстановление сессии: не удалось записать: {e}");
            }
        }
    });
}

// ---------- Аутентификация (auth-сервер) ----------

/// Вход по логину/паролю на auth-сервере.
///
/// Возвращает либо профиль (вход завершён), либо требование второго фактора.
/// При 2FA сессия ещё не выдана: фронтенд собирает код и зовёт `login_2fa`.
#[tauri::command]
async fn login(
    username: String,
    password: String,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<LoginOutcome, String> {
    if username.trim().is_empty() || password.is_empty() {
        return Err("Введите логин и пароль".into());
    }

    match backend::login(&state.http, username.trim(), &password).await? {
        protocol::LoginResult::Ok(auth) => {
            persist_session(&state, &app, auth.profile.clone(), auth.token)?;
            Ok(LoginOutcome::Ok {
                profile: auth.profile,
            })
        }
        protocol::LoginResult::TwoFactorRequired {
            challenge,
            hint,
            button_approval,
        } => Ok(LoginOutcome::TwoFactorRequired {
            challenge,
            hint,
            button_approval,
        }),
    }
}

/// Подтверждение второго фактора: код из Telegram по `challenge` из `login`.
/// При успехе выдаётся сессия и сохраняется так же, как при обычном входе.
#[tauri::command]
async fn login_2fa(
    challenge: String,
    code: String,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<PlayerProfile, String> {
    if code.trim().is_empty() {
        return Err("Введите код из Telegram".into());
    }
    let auth = backend::login_2fa(&state.http, &challenge, code.trim()).await?;
    persist_session(&state, &app, auth.profile.clone(), auth.token)?;
    Ok(auth.profile)
}

/// Преобразует `ChallengeStatus` из бэкенда в `ChallengeOutcome` для фронтенда.
/// Для сценариев входа (2FA, passwordless) при подтверждении сохраняет сессию
/// и возвращает профиль. Используется командами опроса статуса.
fn apply_login_challenge_status(
    state: &State<AppState>,
    app: &AppHandle,
    status: protocol::ChallengeStatus,
) -> Result<ChallengeOutcome, String> {
    match status {
        protocol::ChallengeStatus::Pending => Ok(ChallengeOutcome::Pending),
        protocol::ChallengeStatus::Approved { auth } => {
            // Для сценариев входа сервер всегда присылает сессию.
            let auth = auth.ok_or("Сервер не выдал сессию при подтверждении")?;
            persist_session(state, app, auth.profile.clone(), auth.token)?;
            Ok(ChallengeOutcome::Approved {
                profile: Some(auth.profile),
            })
        }
        protocol::ChallengeStatus::Denied => Ok(ChallengeOutcome::Denied),
        protocol::ChallengeStatus::Expired => Ok(ChallengeOutcome::Expired),
    }
}

/// Опрос подтверждения входа кнопкой «Это я» в Telegram (обычная 2FA).
/// При подтверждении сохраняет сессию и возвращает профиль.
#[tauri::command]
async fn login_2fa_status(
    challenge: String,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<ChallengeOutcome, String> {
    let status = backend::login_2fa_status(&state.http, &challenge).await?;
    apply_login_challenge_status(&state, &app, status)
}

/// Вход без пароля: по нику. Возвращает требование подтверждения кнопкой в
/// Telegram; фронтенд затем опрашивает `passwordless_status`.
#[tauri::command]
async fn passwordless_login(
    username: String,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<LoginOutcome, String> {
    let trimmed = username.trim();
    if trimmed.is_empty() {
        return Err("Введите логин".into());
    }
    match backend::passwordless_login(&state.http, trimmed).await? {
        protocol::LoginResult::Ok(auth) => {
            persist_session(&state, &app, auth.profile.clone(), auth.token)?;
            Ok(LoginOutcome::Ok {
                profile: auth.profile,
            })
        }
        protocol::LoginResult::TwoFactorRequired {
            challenge,
            hint,
            button_approval,
        } => Ok(LoginOutcome::TwoFactorRequired {
            challenge,
            hint,
            button_approval,
        }),
    }
}

/// Опрос подтверждения входа без пароля. При подтверждении сохраняет сессию.
#[tauri::command]
async fn passwordless_status(
    challenge: String,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<ChallengeOutcome, String> {
    let status = backend::passwordless_status(&state.http, &challenge).await?;
    apply_login_challenge_status(&state, &app, status)
}

/// Запуск сброса пароля: по нику. Возвращает challenge для подтверждения
/// кнопкой в Telegram; фронтенд опрашивает `password_reset_status`.
#[tauri::command]
async fn password_reset_start(
    username: String,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<LoginOutcome, String> {
    let trimmed = username.trim();
    if trimmed.is_empty() {
        return Err("Введите логин".into());
    }
    match backend::password_reset_start(&state.http, trimmed).await? {
        protocol::LoginResult::Ok(auth) => {
            persist_session(&state, &app, auth.profile.clone(), auth.token)?;
            Ok(LoginOutcome::Ok {
                profile: auth.profile,
            })
        }
        protocol::LoginResult::TwoFactorRequired {
            challenge,
            hint,
            button_approval,
        } => Ok(LoginOutcome::TwoFactorRequired {
            challenge,
            hint,
            button_approval,
        }),
    }
}

/// Опрос подтверждения сброса пароля. При подтверждении возвращает `Approved`
/// БЕЗ профиля — сессия не выдаётся, пароль ещё не сменён. Лаунчер показывает
/// форму нового пароля и вызывает `password_reset_confirm`.
#[tauri::command]
async fn password_reset_status(
    challenge: String,
    state: State<'_, AppState>,
) -> Result<ChallengeOutcome, String> {
    match backend::password_reset_status(&state.http, &challenge).await? {
        protocol::ChallengeStatus::Pending => Ok(ChallengeOutcome::Pending),
        protocol::ChallengeStatus::Approved { .. } => {
            Ok(ChallengeOutcome::Approved { profile: None })
        }
        protocol::ChallengeStatus::Denied => Ok(ChallengeOutcome::Denied),
        protocol::ChallengeStatus::Expired => Ok(ChallengeOutcome::Expired),
    }
}

/// Установка нового пароля после подтверждения сброса в Telegram. Сессия не
/// выдаётся: после успеха пользователь входит с новым паролем как обычно.
#[tauri::command]
async fn password_reset_confirm(
    challenge: String,
    new_password: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    if new_password.len() < 6 {
        return Err("Пароль: минимум 6 символов".into());
    }
    backend::password_reset_confirm(&state.http, &challenge, &new_password).await
}

/// Регистрация нового аккаунта на auth-сервере.
///
/// Базовая валидация дублируется на сервере; здесь — ранний отказ
/// без сетевого запроса ради отзывчивости UI.
#[tauri::command]
async fn register(
    username: String,
    password: String,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<PlayerProfile, String> {
    let trimmed = username.trim();
    if trimmed.len() < 3 {
        return Err("Имя игрока: минимум 3 символа".into());
    }
    if password.len() < 6 {
        return Err("Пароль: минимум 6 символов".into());
    }

    let auth = backend::register(&state.http, trimmed, &password).await?;
    persist_session(&state, &app, auth.profile.clone(), auth.token)?;
    Ok(auth.profile)
}

/// Завершить сессию.
#[tauri::command]
async fn logout(state: State<'_, AppState>, app: AppHandle) -> Result<(), String> {
    let token = state.token.lock().unwrap().take();
    clear_runtime_session(&state);
    remove_saved_session(&app);
    if let Some(token) = token {
        // Если сервер уже недоступен — локально всё равно считаем, что вышли.
        let _ = backend::logout(&state.http, &token).await;
    }
    Ok(())
}

/// Текущий профиль: сначала берём runtime-сессию, затем пробуем поднять
/// сохранённый `session.json` и проверить токен на auth-сервере.
#[tauri::command]
async fn current_profile(
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<Option<PlayerProfile>, String> {
    if let Some(profile) = state.profile.lock().unwrap().clone() {
        return Ok(Some(profile));
    }

    let Some(saved) = read_saved_session(&app) else {
        return Ok(None);
    };

    match backend::session(&state.http, &saved.token).await {
        Ok(profile) => {
            set_runtime_session(&state, profile.clone(), saved.token);
            recover_pending_session(&app, &state);
            Ok(Some(profile))
        }
        Err(_) => {
            remove_saved_session(&app);
            clear_runtime_session(&state);
            Ok(None)
        }
    }
}

// ---------- Настройки ----------

#[tauri::command]
fn get_settings(app: AppHandle) -> Settings {
    read_settings(&app)
}

#[tauri::command]
fn save_settings(settings: Settings, app: AppHandle) -> Result<(), String> {
    write_settings(&app, &settings)
}

// ---------- Среда запуска ----------

#[tauri::command]
fn app_info(app: AppHandle) -> AppInfo {
    AppInfo {
        mode: paths::launch_mode().as_str().to_string(),
        exe_dir: paths::exe_dir()
            .unwrap_or_else(|| std::path::PathBuf::from("."))
            .to_string_lossy()
            .to_string(),
        portable_marker: paths::portable_marker_exists(),
        data_dir: paths::data_dir(&app).to_string_lossy().to_string(),
        version: env!("CARGO_PKG_VERSION").to_string(),
    }
}

// ---------- Скин (хранится на сервере, привязан к аккаунту) ----------

/// UUID текущего залогиненного аккаунта, либо ошибка «нужен вход».
fn current_session(state: &State<AppState>) -> Result<(String, String), String> {
    let uuid = state
        .profile
        .lock()
        .unwrap()
        .as_ref()
        .map(|p| p.id.clone())
        .ok_or_else(|| "Сначала войдите в аккаунт".to_string())?;
    let token = state
        .token
        .lock()
        .unwrap()
        .clone()
        .ok_or_else(|| "Сессия не найдена, войдите снова".to_string())?;
    Ok((uuid, token))
}

/// Прочитать скин текущего аккаунта с сервера.
///
/// Скин привязан к аккаунту (UUID), поэтому при смене аккаунта на том же
/// устройстве показывается скин нового игрока. Если вход не выполнен или
/// скин не задан — возвращаем пустой скин с моделью по умолчанию.
#[tauri::command]
async fn get_skin(state: State<'_, AppState>) -> Result<Skin, String> {
    let Ok((uuid, _token)) = current_session(&state) else {
        return Ok(Skin {
            data_url: None,
            model: "classic".into(),
            cape_url: None,
            source: None,
        });
    };

    match backend::get_skin(&state.http, &uuid).await? {
        Some(fetched) => {
            // Плащ опционален; ошибку его загрузки не считаем критичной.
            let cape_url = backend::get_cape(&state.http, &uuid)
                .await
                .ok()
                .flatten()
                .map(|b64| format!("data:image/png;base64,{b64}"));
            Ok(Skin {
                data_url: Some(format!("data:image/png;base64,{}", fetched.png_base64)),
                model: normalize_model(&fetched.model),
                cape_url,
                source: fetched.source,
            })
        }
        None => Ok(Skin {
            data_url: None,
            model: "classic".into(),
            cape_url: None,
            source: None,
        }),
    }
}

/// Сохранить скин текущего аккаунта на сервере: принимает data-URL PNG и модель.
#[tauri::command]
async fn set_skin(
    data_url: String,
    model: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let (uuid, token) = current_session(&state)?;

    // Ожидаем `data:image/png;base64,XXXX`.
    let b64 = data_url
        .split_once(',')
        .map(|(_, d)| d)
        .ok_or("Неверный формат изображения")?;

    // Локальная проверка сигнатуры PNG до отправки (сервер тоже проверит).
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(b64)
        .map_err(|_| "Не удалось декодировать PNG")?;
    if bytes.len() < 8 || &bytes[..8] != b"\x89PNG\r\n\x1a\n" {
        return Err("Файл не является PNG".into());
    }

    let skin_model = if model == "slim" {
        protocol::SkinModel::Slim
    } else {
        protocol::SkinModel::Classic
    };
    backend::upload_skin(&state.http, &token, &uuid, b64, skin_model).await
}

/// Импортировать скин и плащ с лицензионного аккаунта Mojang.
///
/// `source` — ник или UUID лицензии. При `keep_synced` сервер хранит UUID
/// источника и периодически перечитывает скин — так он переживает смену ника.
#[tauri::command]
async fn import_skin_from_license(
    source: String,
    keep_synced: bool,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let source = source.trim();
    if source.is_empty() {
        return Err("Укажите ник или UUID лицензии".into());
    }
    let (uuid, token) = current_session(&state)?;
    backend::import_skin(&state.http, &token, &uuid, source, keep_synced).await
}

/// Приводит произвольную строку модели к "slim"/"classic".
fn normalize_model(model: &str) -> String {
    if model == "slim" {
        "slim".into()
    } else {
        "classic".into()
    }
}

// ---------- Аккаунт ----------

/// Расширенные сведения об аккаунте владельца (привязка TG, роль).
#[tauri::command]
async fn account_info(state: State<'_, AppState>) -> Result<protocol::AccountInfo, String> {
    let (_uuid, token) = current_session(&state)?;
    backend::account_info(&state.http, &token).await
}

/// Запросить код привязки Telegram (для включения 2FA).
#[tauri::command]
async fn telegram_link_start(
    state: State<'_, AppState>,
) -> Result<protocol::TelegramLinkResponse, String> {
    let (_uuid, token) = current_session(&state)?;
    backend::telegram_link_start(&state.http, &token).await
}

/// Открыть ссылку во внешнем приложении (браузер, Telegram).
///
/// Окно Tauri не открывает внешние ссылки само (нет navigation на http/https,
/// а плагина opener в сборке нет). Поэтому передаём URL системному
/// обработчику. Разрешаем только безопасные схемы и санизуем URL для Windows,
/// где `cmd /C start` подвержен инъекции через метасимволы.
#[tauri::command]
async fn open_external(url: String) -> Result<(), String> {
    let allowed =
        url.starts_with("https://") || url.starts_with("http://") || url.starts_with("tg://");
    if !allowed {
        return Err("недопустимая схема ссылки".into());
    }

    // На Windows `cmd /C start "" <url>` ретокенизирует аргументы через
    // внутренние правила cmd.exe. Метасимволы `& | < > ^ %` и кавычки в
    // URL могут вырваться за пределы `start`. Отвергаем такие URL.
    #[cfg(target_os = "windows")]
    {
        if url.contains(['&', '|', '<', '>', '^', '%', '"', '`', '\n', '\r']) {
            return Err("URL содержит недопустимые символы".into());
        }
        // CREATE_NO_WINDOW (0x08000000), чтобы консольное окно cmd.exe не
        // мелькало при открытии внешней ссылки — как и прочие spawn на Windows.
        use std::os::windows::process::CommandExt;
        let result = std::process::Command::new("cmd")
            .args(["/C", "start", "", &url])
            .creation_flags(0x0800_0000)
            .spawn();
        result
            .map(|_| ())
            .map_err(|e| format!("не удалось открыть ссылку: {e}"))
    }

    #[cfg(target_os = "macos")]
    {
        let result = std::process::Command::new("open").arg(&url).spawn();
        result
            .map(|_| ())
            .map_err(|e| format!("не удалось открыть ссылку: {e}"))
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let result = std::process::Command::new("xdg-open").arg(&url).spawn();
        result
            .map(|_| ())
            .map_err(|e| format!("не удалось открыть ссылку: {e}"))
    }
}

/// Открыть папку в файловом менеджере.
#[tauri::command]
async fn open_path(path: String) -> Result<(), String> {
    let p = std::path::Path::new(&path);
    if !p.exists() {
        return Err("путь не существует".into());
    }
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        std::process::Command::new("explorer")
            .arg(&path)
            .creation_flags(0x0800_0000)
            .spawn()
            .map(|_| ())
            .map_err(|e| format!("не удалось открыть папку: {e}"))
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(&path)
            .spawn()
            .map(|_| ())
            .map_err(|e| format!("не удалось открыть папку: {e}"))
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        std::process::Command::new("xdg-open")
            .arg(&path)
            .spawn()
            .map(|_| ())
            .map_err(|e| format!("не удалось открыть папку: {e}"))
    }
}

/// Отвязать Telegram (отключить 2FA).
#[tauri::command]
async fn telegram_unlink(state: State<'_, AppState>) -> Result<(), String> {
    let (_uuid, token) = current_session(&state)?;
    backend::telegram_unlink(&state.http, &token).await
}

/// Смена ника. Обновляет runtime- и сохранённую сессию.
#[tauri::command]
async fn change_username(
    new_username: String,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<PlayerProfile, String> {
    let trimmed = new_username.trim();
    if trimmed.len() < 3 {
        return Err("Имя игрока: минимум 3 символа".into());
    }
    let (_uuid, token) = current_session(&state)?;
    let profile = backend::change_username(&state.http, &token, trimmed).await?;
    // Обновляем сохранённую и runtime-сессию новым ником.
    write_saved_session(
        &app,
        &SavedSession {
            profile: profile.clone(),
            token: token.clone(),
        },
    )?;
    set_runtime_session(&state, profile.clone(), token);
    Ok(profile)
}

/// Смена пароля (требует текущий).
#[tauri::command]
async fn change_password(
    current_password: String,
    new_password: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    if new_password.len() < 6 {
        return Err("Пароль: минимум 6 символов".into());
    }
    let (_uuid, token) = current_session(&state)?;
    backend::change_password(&state.http, &token, &current_password, &new_password).await
}

/// Само-удаление аккаунта (требует пароль). После успеха локально выходит.
#[tauri::command]
async fn delete_account(
    password: String,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<(), String> {
    let (_uuid, token) = current_session(&state)?;
    backend::delete_account(&state.http, &token, &password).await?;
    clear_runtime_session(&state);
    remove_saved_session(&app);
    Ok(())
}

// ---------- Запуск игры ----------

/// Запустить игру: подготовить vanilla Minecraft и стартовать JVM.
///
/// Асинхронный лок `launch_lock` гарантирует, что два одновременных вызова
/// не пройдут проверку guard параллельно — lock удерживается на всём
/// протяжении: проверка → запуск → запись PID.
#[tauri::command]
async fn play_game(state: State<'_, AppState>, app: AppHandle) -> Result<(), String> {
    // Занимаем лок на весь цикл: guard → check → launch → record.
    // Если другой поток уже запускает — ждём его завершения, затем проверяем
    // заново (прошлая игра могла завершиться пока мы ждали).
    let _guard = state.launch_lock.lock().await;

    let data_dir = paths::data_dir(&app);

    // Не даём запустить вторую копию, пока предыдущая жива.
    // try_wait() попутно собирает завершённый процесс (zombie reaping).
    {
        let mut guard = state.game.lock().unwrap();
        if let Some(child) = guard.as_mut() {
            match child.try_wait() {
                Ok(Some(_)) | Err(_) => {
                    *guard = None;
                    crate::game_guard::clear(&data_dir);
                }
                Ok(None) => {
                    return Err("Игра уже запущена".into());
                }
            }
        }
    }

    // Кросс-процессная проверка: лаунчер могли закрыть, пока игра работала, и
    // открыть заново — тогда внутрипроцессный guard выше пуст, но игра ещё жива.
    if crate::game_guard::is_running(&data_dir) {
        return Err("Игра уже запущена".into());
    }

    let profile = state
        .profile
        .lock()
        .unwrap()
        .clone()
        .ok_or_else(|| "Сначала войдите в аккаунт".to_string())?;
    let token = state
        .token
        .lock()
        .unwrap()
        .clone()
        .ok_or_else(|| "Сессия не найдена, войдите снова".to_string())?;
    let settings = read_settings(&app);

    let child = minecraft::launch(
        app.clone(),
        &state.http,
        paths::data_dir(&app),
        settings.memory_mb.clamp(512, 32768),
        settings.download_concurrency as usize,
        profile,
        token.clone(),
    )
    .await?;

    let launched_at = time::OffsetDateTime::now_utc();
    let launched_at_str = launched_at
        .format(&time::format_description::well_known::Rfc3339)
        .unwrap_or_default();

    crate::game_guard::record(&data_dir, child.id());
    // Сохраняем на диск: если лаунчер закроется пока игра работает,
    // при следующем старте bootstrap восстановит и запишет сессию.
    crate::game_guard::write_session(&data_dir, child.id(), &launched_at_str);
    *state.game.lock().unwrap() = Some(child);

    // Фоновая задача: ждём завершения игры и отправляем статистику на сервер.
    let http = state.http.clone();
    let data_dir2 = data_dir.clone();
    tokio::spawn(async move {
        // Ждём завершения процесса, опрашивая каждые 2 секунды.
        loop {
            tokio::time::sleep(std::time::Duration::from_secs(2)).await;
            if !crate::game_guard::is_running(&data_dir2) {
                break;
            }
        }

        let duration = (time::OffsetDateTime::now_utc() - launched_at).whole_seconds().max(0);
        crate::game_guard::clear_session(&data_dir2);
        if duration > 0 {
            if let Err(e) =
                backend::record_session(&http, &token, duration, &launched_at_str).await
            {
                tracing::warn!("[stats] не удалось записать сессию: {e}");
            }
        }
    });

    Ok(())
}

// ---------- Статистика ----------

/// Получить статистику игрока с сервера (playtime, last_launched_at).
#[tauri::command]
async fn get_stats(state: State<'_, AppState>) -> Result<protocol::PlayerStats, String> {
    let (_uuid, token) = current_session(&state)?;
    backend::get_stats(&state.http, &token).await
}

// ---------- Сборка (модпак) ----------

/// Игровой каталог сборки внутри папки данных лаунчера.
fn game_dir(app: &AppHandle) -> std::path::PathBuf {
    paths::data_dir(app).join("minecraft").join("game")
}

/// Список опциональных модов активной сборки с состоянием вкл/выкл.
#[tauri::command]
async fn list_optional_mods(
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<Vec<crate::modpack::OptionalMod>, String> {
    crate::modpack::list_optional_mods(&state.http, &paths::data_dir(&app), &game_dir(&app)).await
}

/// Включить/выключить опциональный мод. Сохраняет выбор и, если файл уже
/// скачан, мгновенно переименовывает его (± `.dis`).
#[tauri::command]
async fn set_mod_enabled(
    mod_id: String,
    enabled: bool,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<(), String> {
    crate::modpack::set_mod_enabled(
        &state.http,
        &paths::data_dir(&app),
        &game_dir(&app),
        mod_id,
        enabled,
    )
    .await
}

/// Жив ли сейчас процесс игры. Фронт опрашивает это, чтобы держать
/// кнопку «Играть» неактивной, пока Minecraft запущен.
#[tauri::command]
fn game_running(state: State<'_, AppState>, app: AppHandle) -> bool {
    let data_dir = paths::data_dir(&app);
    let mut guard = state.game.lock().unwrap();
    match guard.as_mut() {
        Some(child) => match child.try_wait() {
            Ok(Some(_)) | Err(_) => {
                *guard = None;
                crate::game_guard::clear(&data_dir);
                false
            }
            Ok(None) => true,
        },
        None => false,
    }
}

/// Пинг Minecraft-сервера: резолвит SRV-запись `_minecraft._tcp.<host>`,
/// затем открывает TCP-соединение и шлёт Server List Ping (MC protocol).
/// Возвращает `{ online: bool, players: Option<u32> }`.
#[tauri::command]
async fn ping_minecraft_server(host: String) -> serde_json::Value {
    use hickory_resolver::TokioResolver;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpStream;
    use tokio::time::{timeout, Duration};

    // 1. SRV-запись _minecraft._tcp.<host>
    let (target_host, target_port): (String, u16) = {
        let resolver = match TokioResolver::builder_tokio() {
            Ok(b) => b.build(),
            Err(_) => return serde_json::json!({ "online": false, "players": null }),
        };
        let srv_name = format!("_minecraft._tcp.{host}");
        match resolver.srv_lookup(srv_name.as_str()).await {
            Ok(lookup) => match lookup.iter().next() {
                Some(srv) => {
                    let h = srv.target().to_string();
                    let h = h.trim_end_matches('.').to_string();
                    (h, srv.port())
                }
                None => (host.clone(), 25565),
            },
            Err(_) => (host.clone(), 25565),
        }
    };

    // 2. TCP + Server List Ping (MC 1.7+ handshake, protocol -1 = status)
    let addr = format!("{target_host}:{target_port}");
    let ping = timeout(Duration::from_secs(5), async {
        let t0 = std::time::Instant::now();
        let mut stream = TcpStream::connect(&addr).await?;
        let ping_ms = t0.elapsed().as_millis() as u64;

        // Build handshake payload
        let host_bytes = target_host.as_bytes();
        let mut hs: Vec<u8> = Vec::new();
        hs.push(0x00); // packet id
        mc_write_varint(&mut hs, 0xFF_FF_FF_FF); // protocol version = -1
        mc_write_varint(&mut hs, host_bytes.len() as u32);
        hs.extend_from_slice(host_bytes);
        hs.extend_from_slice(&target_port.to_be_bytes());
        hs.push(0x01); // next state: status

        let mut pkt: Vec<u8> = Vec::new();
        mc_write_varint(&mut pkt, hs.len() as u32);
        pkt.extend_from_slice(&hs);
        stream.write_all(&pkt).await?;

        // Status request
        stream.write_all(&[0x01, 0x00]).await?;

        // Read response
        let _pkt_len = mc_read_varint(&mut stream).await?;
        let _pkt_id  = mc_read_varint(&mut stream).await?;
        let str_len  = mc_read_varint(&mut stream).await? as usize;
        let mut buf = vec![0u8; str_len.min(8192)];
        stream.read_exact(&mut buf).await?;
        let json: serde_json::Value =
            serde_json::from_slice(&buf).unwrap_or(serde_json::Value::Null);
        Ok::<_, std::io::Error>((json, ping_ms))
    })
    .await;

    match ping {
        Ok(Ok((json, ping_ms))) => {
            let players = json
                .get("players")
                .and_then(|p| p.get("online"))
                .and_then(|v| v.as_u64());
            let max = json
                .get("players")
                .and_then(|p| p.get("max"))
                .and_then(|v| v.as_u64());
            serde_json::json!({ "online": true, "players": players, "max": max, "ping": ping_ms })
        }
        _ => serde_json::json!({ "online": false, "players": null }),
    }
}

fn mc_write_varint(buf: &mut Vec<u8>, mut v: u32) {
    loop {
        let mut b = (v & 0x7f) as u8;
        v >>= 7;
        if v != 0 { b |= 0x80; }
        buf.push(b);
        if v == 0 { break; }
    }
}

async fn mc_read_varint(stream: &mut tokio::net::TcpStream) -> std::io::Result<u32> {
    use tokio::io::AsyncReadExt;
    let (mut result, mut shift) = (0u32, 0u32);
    loop {
        let b = stream.read_u8().await?;
        result |= ((b & 0x7f) as u32) << shift;
        if b & 0x80 == 0 { break; }
        shift += 7;
        if shift >= 35 {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData, "varint overflow",
            ));
        }
    }
    Ok(result)
}

/// Регистрирует все команды и состояние в Tauri-приложении.
pub fn init(builder: tauri::Builder<tauri::Wry>) -> tauri::Builder<tauri::Wry> {
    builder
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![
            login,
            login_2fa,
            login_2fa_status,
            passwordless_login,
            passwordless_status,
            password_reset_start,
            password_reset_status,
            password_reset_confirm,
            register,
            logout,
            current_profile,
            get_settings,
            save_settings,
            app_info,
            get_skin,
            set_skin,
            import_skin_from_license,
            account_info,
            telegram_link_start,
            open_external,
            open_path,
            telegram_unlink,
            change_username,
            change_password,
            delete_account,
            play_game,
            game_running,
            get_stats,
            list_optional_mods,
            set_mod_enabled,
            crate::update::check_update,
            crate::update::install_update,
            ping_minecraft_server,
        ])
}
