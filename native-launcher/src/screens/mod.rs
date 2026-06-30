//! Main module for screens and navigation.

pub mod login;
pub mod main_screen;
pub mod settings;
pub mod title_bar;

use std::sync::Arc;

use iced::{Element, Task, Theme};
use iced::window;

use crate::api;
use crate::api::{LauncherSettings, PlayerProfile, PlayerStats, SavedSession, ServerStatus};
use crate::progress::{Progress, ProgressSnapshot};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Screen {
    Login,
    Main,
    Settings,
}

pub struct App {
    pub screen: Screen,
    pub profile: Option<PlayerProfile>,
    pub token: Option<String>,
    pub theme: Theme,
    pub login: login::State,
    pub main: main_screen::State,
    pub settings: settings::State,
    pub data_dir: std::path::PathBuf,
    pub exit: bool,
    pub progress: Option<Arc<Progress>>,
    pub game_pid: Option<u32>,
    pub window_id: Option<window::Id>,
}

#[derive(Debug, Clone)]
pub enum Message {
    NavigateTo(Screen),
    Login(login::Message),
    Main(main_screen::Message),
    Settings(settings::Message),
    SessionRestored(Result<PlayerProfile, String>),
    StatsLoaded(Result<PlayerStats, String>),
    ServerPinged(Result<ServerStatus, String>),
    SettingsLoaded(LauncherSettings),
    // Play flow
    PlayStarted,
    ManifestLoaded(Result<Option<crate::api::Manifest>, String>),
    ModpackSynced(Result<usize, String>),
    GameLaunched(Result<u32, String>),
    ProgressTick(ProgressSnapshot),
    GameExited,
    // Window
    WindowIdLoaded(Option<window::Id>),
    DragWindow,
    Minimize,
    CloseRequested,
}

impl App {
    pub fn new() -> (Self, Task<Message>) {
        let data_dir = crate::paths::data_dir();
        let _ = std::fs::create_dir_all(&data_dir);

        // Recover pending session from previous launch
        let token = api::load_session(&data_dir)
            .map(|s| s.access_token.clone())
            .unwrap_or_default();
        if !token.is_empty() {
            if let Some((duration, launched_at)) = crate::game_guard::recover_pending_session(&data_dir) {
                let t = token.clone();
                tokio::spawn(async move {
                    let _ = api::record_session(&t, duration as u64, &launched_at).await;
                });
            }
            // Drain any queued pending sessions
            let pending = crate::game_guard::drain_pending_sessions(&data_dir);
            for record in pending {
                let t = token.clone();
                tokio::spawn(async move {
                    let _ = api::record_session(&t, record.duration as u64, &record.launched_at).await;
                });
            }
        }

        let app = App {
            screen: Screen::Login,
            profile: None,
            token: None,
            theme: Theme::Dark,
            login: login::State::new(),
            main: main_screen::State::new(),
            settings: settings::State::new(),
            data_dir,
            exit: false,
            progress: None,
            game_pid: None,
            window_id: None,
        };

        let task = Task::batch([
            Task::perform(
                restore_session(app.data_dir.clone()),
                Message::SessionRestored,
            ),
            window::get_latest().map(Message::WindowIdLoaded),
        ]);

        (app, task)
    }
}

async fn restore_session(data_dir: std::path::PathBuf) -> Result<PlayerProfile, String> {
    let saved = api::load_session(&data_dir).ok_or("Нет сохранённой сессии")?;
    api::session(&saved.access_token).await
}

pub fn update(state: &mut App, message: Message) -> Task<Message> {
    match message {
        Message::NavigateTo(screen) => {
            state.screen = screen;
            Task::none()
        }

        // ─── Window ─────────────────────────────────
        Message::WindowIdLoaded(id) => {
            state.window_id = id;
            Task::none()
        }
        Message::DragWindow => {
            if let Some(id) = state.window_id {
                window::drag(id)
            } else {
                Task::none()
            }
        }
        Message::Minimize => {
            if let Some(id) = state.window_id {
                window::minimize(id, true)
            } else {
                Task::none()
            }
        }
        Message::CloseRequested => {
            state.exit = true;
            iced::exit()
        }

        // ─── Login ──────────────────────────────
        Message::Login(msg) => {
            let task = state.login.update(msg.clone());
            if let login::Message::LoginSuccess(lr) = msg {
                state.profile = Some(lr.profile.clone());
                state.token = Some(lr.access_token.clone());
                state.screen = Screen::Main;

                let data_dir = state.data_dir.clone();
                let _ = api::save_session(
                    &data_dir,
                    &SavedSession {
                        profile: lr.profile,
                        access_token: lr.access_token.clone(),
                        client_token: lr.client_token,
                    },
                );

                let t1 = Task::perform(
                    load_stats_with_cache(state.data_dir.clone(), lr.access_token),
                    Message::StatsLoaded,
                );
                let t2 = Task::perform(ping_server(), Message::ServerPinged);
                let t3 =
                    Task::perform(load_local_settings(state.data_dir.clone()), Message::SettingsLoaded);
                return Task::batch([task.map(Message::Login), t1, t2, t3]);
            }
            task.map(Message::Login)
        }

        // ─── Session restored ───────────────────
        Message::SessionRestored(Ok(profile)) => {
            let saved = api::load_session(&state.data_dir);
            let token = saved
                .as_ref()
                .map(|s| s.access_token.clone())
                .unwrap_or_default();

            state.profile = Some(profile);
            state.token = Some(token.clone());
            state.screen = Screen::Main;

            let t1 = Task::perform(
                load_stats_with_cache(state.data_dir.clone(), token),
                Message::StatsLoaded,
            );
            let t2 = Task::perform(ping_server(), Message::ServerPinged);
            let t3 =
                Task::perform(load_local_settings(state.data_dir.clone()), Message::SettingsLoaded);
            Task::batch([t1, t2, t3])
        }
        Message::SessionRestored(Err(_)) => Task::none(),

        // ─── Stats ──────────────────────────────
        Message::StatsLoaded(Ok(stats)) => {
            state.main.stats = Some(stats);
            Task::none()
        }
        Message::StatsLoaded(Err(_)) => Task::none(),

        // ─── Server ─────────────────────────────
        Message::ServerPinged(Ok(server)) => {
            state.main.server = Some(server);
            Task::none()
        }
        Message::ServerPinged(Err(_)) => Task::none(),

        // ─── Settings ───────────────────────────
        Message::SettingsLoaded(s) => {
            state.settings.settings = Some(s);
            Task::none()
        }

        // ─── Main screen ────────────────────────
        Message::Main(main_screen::Message::Play) => {
            if crate::game_guard::is_running(&state.data_dir) {
                state.main.busy = false;
                state.main.status_text = "Игра уже запущена".to_string();
                return Task::none();
            }
            state.main.busy = true;
            state.main.progress = Some(ProgressSnapshot {
                phase: "checking".into(),
                label: "Загрузка манифеста…".into(),
                fraction: 0.0,
                stage: "Старт".into(),
                downloaded_bytes: None,
                total_bytes: None,
                speed_bytes_per_sec: None,
                eta_seconds: None,
            });

            let progress = Arc::new(Progress::new());
            state.progress = Some(progress.clone());

            let data_dir = state.data_dir.clone();
            Task::perform(
                async move {
                    crate::api::fetch_manifest(&data_dir).await
                },
                Message::ManifestLoaded,
            )
        }
        Message::Main(main_screen::Message::OpenSettings) => {
            state.screen = Screen::Settings;
            Task::none()
        }
        Message::Main(main_screen::Message::Logout) => {
            crate::game_guard::clear_session(&state.data_dir);
            crate::game_guard::clear(&state.data_dir);
            api::delete_session(&state.data_dir);
            state.profile = None;
            state.token = None;
            state.screen = Screen::Login;
            Task::none()
        }

        // ─── Play flow ──────────────────────────
        Message::ManifestLoaded(Ok(Some(_manifest))) => {
            if let Some(ref p) = state.progress {
                p.begin(crate::progress::Stage::Modpack, "checking", "Синхронизация модпака…");
            }
            state.main.progress = Some(ProgressSnapshot {
                phase: "checking".into(),
                label: "Синхронизация модпака…".into(),
                fraction: 0.1,
                stage: "Модпак".into(),
                downloaded_bytes: None,
                total_bytes: None,
                speed_bytes_per_sec: None,
                eta_seconds: None,
            });
            launch_game(state)
        }
        Message::ManifestLoaded(Ok(None)) => {
            state.main.status_text = "Нет сборки, запуск…".to_string();
            launch_game(state)
        }
        Message::ManifestLoaded(Err(e)) => {
            state.main.busy = false;
            state.main.progress = None;
            state.main.status_text = format!("Ошибка манифеста: {e}");
            Task::none()
        }

        Message::ModpackSynced(Ok(n)) => {
            state.main.status_text = format!("Скачано файлов: {n}. Запуск…");
            launch_game(state)
        }
        Message::ModpackSynced(Err(e)) => {
            state.main.busy = false;
            state.main.progress = None;
            state.main.status_text = format!("Ошибка синхронизации: {e}");
            Task::none()
        }

        Message::GameLaunched(Ok(pid)) => {
            state.game_pid = Some(pid);
            state.main.busy = false;
            state.main.progress = None;
            state.main.status_text = "Игра запущена".to_string();

            // Record PID
            let now = chrono::Utc::now().to_rfc3339();
            crate::game_guard::record(&state.data_dir, pid);
            crate::game_guard::write_session(&state.data_dir, pid, &now);

            // Spawn game exit watcher
            let data_dir = state.data_dir.clone();
            let token = state.token.clone().unwrap_or_default();
            let _launched_at = now.clone();
            tokio::spawn(async move {
                // Wait for game to exit
                loop {
                    tokio::time::sleep(std::time::Duration::from_secs(2)).await;
                    if !crate::game_guard::is_running(&data_dir) {
                        break;
                    }
                }
                crate::game_guard::clear(&data_dir);
                crate::game_guard::clear_session(&data_dir);

                // Calculate session duration from game_session.json
                if let Some(pending) = crate::game_guard::read_session(&data_dir) {
                    if let Ok(launched) = chrono::DateTime::parse_from_rfc3339(&pending.launched_at) {
                        let duration = chrono::Utc::now()
                            .signed_duration_since(launched.with_timezone(&chrono::Utc))
                            .num_seconds();
                        if duration > 0 {
                            let _ = api::record_session(&token, duration as u64, &pending.launched_at).await;
                        }
                    }
                    crate::game_guard::clear_session(&data_dir);
                }
            });

            Task::none()
        }
        Message::GameLaunched(Err(e)) => {
            state.main.busy = false;
            state.main.progress = None;
            state.main.status_text = format!("Ошибка запуска: {e}");
            Task::none()
        }

        Message::ProgressTick(snapshot) => {
            if state.main.busy {
                state.main.progress = Some(snapshot);
            }
            Task::none()
        }

        Message::GameExited => Task::none(),
        Message::PlayStarted => Task::none(),

        Message::Settings(msg) => {
            let task = state.settings.update(msg.clone());
            if let settings::Message::Close = msg {
                state.screen = Screen::Main;
            }
            task.map(Message::Settings)
        }
    }
}

fn launch_game(state: &App) -> Task<Message> {
    let data_dir = state.data_dir.clone();
    let game_dir = api::game_dir(&data_dir);
    let profile = state.profile.clone();
    let token = state.token.clone();
    let settings = state.settings.settings.clone();
    let progress = state.progress.clone();

    Task::perform(
        async move {
            let profile = profile.ok_or("Нет профиля")?;
            let token = token.ok_or("Нет токена")?;
            let settings = settings.unwrap_or_default();
            let progress = progress.ok_or("Нет прогресса")?;

            let concurrency = settings.download_concurrency as usize;

            crate::minecraft::launch(
                &crate::minecraft::LaunchArgs {
                    username: profile.name.clone(),
                    uuid: profile.uuid.clone(),
                    access_token: token,
                    client_token: String::new(),
                    memory_mb: settings.memory_mb,
                    game_dir,
                    data_dir,
                    server: Some("mc.zeragorn.xyz".to_string()),
                    download_concurrency: concurrency,
                },
                progress,
            )
            .await
        },
        Message::GameLaunched,
    )
}

pub fn view(state: &App) -> Element<'_, Message> {
    let content = match state.screen {
        Screen::Login => state.login.view().map(Message::Login),
        Screen::Main => state.main.view().map(Message::Main),
        Screen::Settings => state.settings.view().map(Message::Settings),
    };

    iced::widget::column![
        title_bar::view(state.screen, state.profile.as_ref()),
        content,
    ]
    .into()
}

// ─── Helpers ───────────────────────────────────────────────

async fn load_stats_with_cache(
    data_dir: std::path::PathBuf,
    token: String,
) -> Result<PlayerStats, String> {
    match api::get_stats(&token).await {
        Ok(stats) => {
            api::save_cached_stats(&data_dir, &stats);
            Ok(stats)
        }
        Err(_) => api::load_cached_stats(&data_dir).ok_or("Нет данных".to_string()),
    }
}

async fn ping_server() -> Result<ServerStatus, String> {
    let start = std::time::Instant::now();
    let mut builder = reqwest::Client::builder()
        .user_agent(format!("stardust-launcher/{}", env!("CARGO_PKG_VERSION")))
        .connect_timeout(std::time::Duration::from_secs(5))
        .timeout(std::time::Duration::from_secs(10));
    if let Ok(proxy) = reqwest::Proxy::all("http://assets.zeragorn.xyz:3128") {
        builder = builder.proxy(proxy);
    }
    let http = builder.build().unwrap_or_default();

    let resp = http
        .get("https://mc.zeragorn.xyz/status/json/52476")
        .send()
        .await
        .map_err(|e| format!("Сеть: {e}"))?;

    let elapsed = start.elapsed().as_millis() as u32;
    let body: serde_json::Value = resp.json().await.map_err(|e| format!("Парсинг: {e}"))?;

    let online = body
        .get("online")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let players = body
        .get("players")
        .and_then(|p| p.get("online"))
        .and_then(|v| v.as_i64())
        .map(|n| n as i32);
    let max = body
        .get("players")
        .and_then(|p| p.get("max"))
        .and_then(|v| v.as_i64())
        .map(|n| n as i32);

    Ok(ServerStatus {
        online,
        players,
        max,
        ping: Some(elapsed),
    })
}

async fn load_local_settings(data_dir: std::path::PathBuf) -> LauncherSettings {
    api::load_settings(&data_dir)
}
