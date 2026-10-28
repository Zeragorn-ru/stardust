//! Admin REST API.
//!
//! Веб-админка (`admin-web`) ходит сюда с bearer-токеном админа. Сервер
//! управляет сборкой (модпаком): создаёт сборки, принимает файлы (моды,
//! конфиги), складывает их байты в каталог `modpack-data` под именем `sha1`,
//! а метаданные — в общий `store`. Лаунчер тянет отсюда клиентский манифест
//! (`GET /manifest`) и сами файлы (`GET /files/<sha1>`).
//!
//! Доступ к БД и сессиям переиспользуется из крейта `store` — те же аккаунты
//! и токены, что и у auth-server. Админом считается аккаунт с ролью `admin`.

use rand::{distributions::Alphanumeric, Rng};
use std::path::PathBuf;
use std::str::FromStr;
use std::sync::Arc;
use std::time::{Duration, Instant};


use axum::{
    extract::{ConnectInfo, DefaultBodyLimit, Multipart, Path, Query, State},
    http::{header, HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{delete, get, post, put},
    Json, Router,
};
use axum::middleware::{self, Next};
use futures_util::TryStreamExt;
use serde::{Deserialize, Serialize};
use sha1::{Digest, Sha1};
use store::{
    NewBuild, Role, SeasonRow, Store, SETTING_ACHIEVEMENT_COIN_REWARD, SETTING_BACKUP_ACCESS_KEY,
    SETTING_BACKUP_BUCKET, SETTING_BACKUP_ENDPOINT, SETTING_BACKUP_PREFIX, SETTING_BACKUP_REGION,
    SETTING_BACKUP_SECRET_KEY, SETTING_GITHUB_TOKEN, SETTING_SFTP_HOST, SETTING_SFTP_PASSWORD,
    SETTING_SFTP_STATS_PATH, SETTING_SFTP_USERNAME, SETTING_TELEGRAM_TOKEN,
    SETTING_TELEGRAM_USERNAME,
};
use time::format_description::well_known::Rfc3339;
use time::OffsetDateTime;
use tokio::sync::Mutex;
use tower_http::cors::CorsLayer;
use tower_http::services::ServeDir;

mod backup;

/// Максимальный размер тела запроса на загрузку файла (один мод/конфиг).
/// Задаётся только на multipart-маршруте загрузки, не глобально.
const MAX_UPLOAD_BYTES: usize = 512 * 1024 * 1024; // 512 МБ
/// Общий лимит тела для всех остальных (JSON) маршрутов — включая
/// анонимные /api/login и /files.
const MAX_JSON_BODY_BYTES: usize = 16 * 1024 * 1024; // 16 МБ
const MAX_NEWS_TITLE_CHARS: usize = 120;
const MAX_NEWS_MARKDOWN_CHARS: usize = 12_000;
const MAX_GUIDE_TITLE_CHARS: usize = 120;
const MAX_GUIDE_SLUG_CHARS: usize = 80;
const MAX_GUIDE_EXCERPT_CHARS: usize = 240;
const MAX_GUIDE_MARKDOWN_CHARS: usize = 40_000;

/// URL совместимого алиаса последней StarDust-сборки authlib-injector.
const DEFAULT_AUTHLIB_INJECTOR_URL: &str =
    "https://github.com/Zeragorn-ru/stardust/releases/download/authlib-injector-stable/authlib-injector.jar";
const DEFAULT_AUTHLIB_INJECTOR_METADATA_URL: &str =
    "https://github.com/Zeragorn-ru/stardust/releases/download/authlib-injector-stable/authlib-injector.json";

/// Как часто перепроверять последнюю версию injector.
const INJECTOR_TTL: Duration = Duration::from_secs(6 * 60 * 60); // 6 часов

type Shared = Arc<AppState>;

struct AppState {
    store: Store,
    /// Каталог с байтами файлов сборки (modpack-data).
    modpack_dir: PathBuf,
    /// Публичный префикс, под которым лаунчер качает файлы (напр.
    /// `https://host/files`). Подставляется в URL манифеста.
    files_base_url: String,
    /// HTTP-клиент для скачивания закреплённого authlib-injector.
    http: reqwest::Client,
    /// URL jar-файла последней StarDust-сборки.
    injector_url: String,
    /// URL JSON-метаданных последней версии.
    injector_metadata_url: String,
    /// Резервные значения для старого deployment без metadata JSON.
    injector_version: String,
    injector_sha256: Option<String>,
    /// Кэш jar-файла authlib-injector (см. `INJECTOR_TTL`).
    injector: Mutex<Option<InjectorCache>>,
    /// Защита от параллельных SFTP-синхронизаций одной панели.
    sync_to_panel_running: Mutex<Option<i64>>,
    /// Последний статус SFTP-синхронизации для polling из админки.
    sync_to_panel_status: Mutex<SyncStatus>,
    /// Защита от параллельных деплоев мода.
    deploy_mod_running: Mutex<bool>,
    /// Последний статус деплоя мода для polling из админки.
    deploy_mod_status: Mutex<DeployModStatus>,
    backup_source_dir: PathBuf,
    backup_running: Mutex<bool>,
    backup_status: Mutex<backup::Status>,
    /// Защита от параллельных архиваций сезонов.
    season_archive_running: Mutex<bool>,
    /// Последний статус архивации сезона для polling из админки.
    season_archive_status: Mutex<SeasonArchiveStatus>,
    /// Защита от параллельных канальных задач: promote и set-latest оба
    /// финально пишут latest.json алиасов, одновременно им нельзя.
    release_task_running: Mutex<bool>,
    /// Последний статус продвижения релиза для polling из админки.
    promote_status: Mutex<PromoteStatus>,
    /// Последний статус перестановки latest-тега для polling из админки.
    set_latest_status: Mutex<SetLatestStatus>,
}

/// Закэшированный authlib-injector.jar с временем загрузки.
struct InjectorCache {
    bytes: Vec<u8>,
    version: String,
    sha256: Option<String>,
    fetched: Instant,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
struct InjectorMetadata {
    version: String,
    #[serde(default)]
    sha256: Option<String>,
    #[serde(rename = "downloadUrl", default)]
    download_url: Option<String>,
}

#[tokio::main]
async fn main() {
    let log_dir = std::env::var("LOG_DIR").unwrap_or_else(|_| "logs".into());
    // rolling::daily паникует при незаписываемом каталоге (expect внутри
    // конструктора). Builder возвращает Err — тогда логируем только в stdout:
    // старт важнее файловых логов (как в лаунчере, см. его lib.rs).
    let stdout_layer = tracing_subscriber::fmt::layer().with_writer(std::io::stdout);
    let file_layer = tracing_appender::rolling::RollingFileAppender::builder()
        .rotation(tracing_appender::rolling::Rotation::DAILY)
        .filename_prefix("admin-server.log")
        .build(&log_dir)
        .map(|appender| {
            let (non_blocking, _guard) = tracing_appender::non_blocking(appender);
            // Guard должен жить весь процесс, иначе хвост логов теряется.
            std::mem::forget(_guard);
            tracing_subscriber::fmt::layer().with_writer(non_blocking)
        });

    let env_filter = tracing_subscriber::EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| "admin_server=info,tower_http=warn".into());

    use tracing_subscriber::prelude::*;
    match file_layer {
        Ok(file_layer) => {
            tracing_subscriber::registry()
                .with(env_filter)
                .with(stdout_layer)
                .with(file_layer)
                .init();
        }
        Err(_) => {
            tracing_subscriber::registry()
                .with(env_filter)
                .with(stdout_layer)
                .init();
        }
    }

    let database_url = std::env::var("DATABASE_URL")
        .expect("переменная окружения DATABASE_URL обязательна (строка подключения PostgreSQL)");
    let store = Store::connect(&database_url)
        .await
        .unwrap_or_else(|e| panic!("не удалось подключиться к БД: {e:?}"));
    tracing::info!("хранилище: PostgreSQL");

    // Выдача первого админа. Веб-админка пускает только роль `admin`, но
    // регистрация всегда создаёт `user` — поэтому самого первого админа
    // неоткуда взять. `ADMIN_BOOTSTRAP` со списком логинов (через запятую)
    // повышает уже существующие аккаунты до `admin` при старте. Операция
    // идемпотентна: можно держать переменную постоянно, повторный запуск
    // ничего не ломает.
    bootstrap_admins(&store).await;

    let modpack_dir =
        PathBuf::from(std::env::var("MODPACK_DIR").unwrap_or_else(|_| "modpack-data".to_string()));
    std::fs::create_dir_all(&modpack_dir)
        .unwrap_or_else(|e| panic!("не удалось создать каталог сборки {modpack_dir:?}: {e}"));

    // Публичный URL раздачи файлов. По умолчанию — наш же `/files`.
    let files_base_url = std::env::var("FILES_BASE_URL")
        .ok()
        .map(|s| s.trim().trim_end_matches('/').to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "http://127.0.0.1:8081/files".to_string());

    let injector_url = std::env::var("AUTHLIB_INJECTOR_URL")
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| DEFAULT_AUTHLIB_INJECTOR_URL.to_string());
    let injector_metadata_url = std::env::var("AUTHLIB_INJECTOR_METADATA_URL")
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| DEFAULT_AUTHLIB_INJECTOR_METADATA_URL.to_string());
    let injector_version = std::env::var("AUTHLIB_INJECTOR_VERSION")
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "stable".to_string());
    let injector_sha256 = std::env::var("AUTHLIB_INJECTOR_SHA256")
        .ok()
        .map(|s| s.trim().to_ascii_lowercase())
        .filter(|s| !s.is_empty());

    let state = Arc::new(AppState {
        store,
        modpack_dir: modpack_dir.clone(),
        files_base_url,
        http: reqwest::Client::builder()
            .user_agent(concat!("admin-server/", env!("CARGO_PKG_VERSION")))
            .build()
            .expect("не удалось собрать HTTP-клиент"),
        injector_url,
        injector_metadata_url,
        injector_version,
        injector_sha256,
        injector: Mutex::new(None),
        sync_to_panel_running: Mutex::new(None),
        sync_to_panel_status: Mutex::new(SyncStatus::default()),
        deploy_mod_running: Mutex::new(false),
        deploy_mod_status: Mutex::new(DeployModStatus::default()),
        backup_source_dir: PathBuf::from(
            std::env::var("BACKUP_SOURCE_DIR").unwrap_or_else(|_| "/data".to_string()),
        ),
        backup_running: Mutex::new(false),
        backup_status: Mutex::new(backup::Status::default()),
        season_archive_running: Mutex::new(false),
        season_archive_status: Mutex::new(SeasonArchiveStatus::default()),
        release_task_running: Mutex::new(false),
        promote_status: Mutex::new(PromoteStatus::default()),
        set_latest_status: Mutex::new(SetLatestStatus::default()),
    });

    // Фоновая задача: синхронизация статистики с SFTP каждые 15 минут.
    let bg_state = Arc::clone(&state);
    tokio::spawn(async move {
        loop {
            match do_sync_stats(&bg_state).await {
                Ok(updated) if updated > 0 => {
                    tracing::info!("[stats] синхронизация: обновлено {updated} игроков");
                }
                Ok(_) => {}
                Err(e) => {
                    tracing::warn!("[stats] синхронизация: {e}");
                }
            }
            tokio::time::sleep(Duration::from_secs(15 * 60)).await;
        }
    });

    // Ежедневный бекап: первый запуск после старта, затем раз в 24 часа.
    let backup_state = Arc::clone(&state);
    tokio::spawn(async move {
        loop {
            if let Err(e) = start_backup(Arc::clone(&backup_state), false).await {
                tracing::warn!("[backup] {e}");
            }
            tokio::time::sleep(Duration::from_secs(24 * 60 * 60)).await;
        }
    });

    // Ретеншн телеметрии: раз в сутки чистим срезы/события старше 30 дней
    // и журналы старше 90 — иначе таблицы растут бесконечно.
    let telemetry_state = Arc::clone(&state);
    tokio::spawn(async move {
        loop {
            match telemetry_state.store.purge_old_telemetry().await {
                Ok(0) => {}
                Ok(n) => tracing::info!("[telemetry] ретеншн: удалено {n} строк"),
                Err(e) => tracing::warn!("[telemetry] ретеншн: {e}"),
            }
            tokio::time::sleep(Duration::from_secs(24 * 60 * 60)).await;
        }
    });

    let cors = {
        let allowed_origins = std::env::var("CORS_ALLOWED_ORIGINS")
            .ok()
            .map(|s| {
                s.split(',')
                    .map(|o| o.trim().to_string())
                    .filter(|o| !o.is_empty())
                    .collect::<Vec<_>>()
            })
            .filter(|v| !v.is_empty());

        match allowed_origins {
            Some(origins) => {
                tracing::info!("CORS: разрешённые origins: {:?}", origins);
                let origins = origins
                    .iter()
                    .filter_map(|origin| origin.parse().ok())
                    .collect::<Vec<_>>();
                CorsLayer::new().allow_origin(origins)
            }
            None => {
                tracing::warn!(
                    "CORS: allowed origins не заданы, разрешаем все (только для разработки!)"
                );
                CorsLayer::permissive()
            }
        }
    };

    let router = Router::new()
        .route("/health", get(health))
        // --- Админка (нужен токен админа) ---
        .route("/api/login", post(login))
        .route("/api/logout", post(logout))
        .route("/api/me", get(me))
        .route("/api/settings", get(get_settings).put(update_settings))
        .route("/api/news", get(list_news).post(create_news))
        .route(
            "/api/news/:id",
            axum::routing::patch(update_news).delete(delete_news),
        )
        .route("/api/guides", get(list_guides).post(create_guide))
        .route(
            "/api/guides/:id",
            axum::routing::patch(update_guide).delete(delete_guide),
        )
        .route("/api/builds", get(list_builds).post(create_build))
        .route(
            "/api/builds/:id",
            get(get_build).patch(update_build).delete(delete_build),
        )
        .route("/api/builds/:id/activate", post(activate_build))
        .route("/api/builds/:id/clone", post(clone_build))
        // Multipart-загрузка файлов сборки — единственный маршрут, которому
        // нужен лимит в сотни МБ; см. MAX_UPLOAD_BYTES.
        .route(
            "/api/builds/:id/files",
            post(upload_file).layer(DefaultBodyLimit::max(MAX_UPLOAD_BYTES)),
        )
        .route("/api/builds/:id/folder-archive", get(folder_archive))
        .route(
            "/api/builds/:id/mod-profiles",
            get(list_mod_profiles).post(upsert_mod_profile),
        )
        .route(
            "/api/builds/:id/mod-profiles/:key",
            delete(delete_mod_profile),
        )
        .route(
            "/api/builds/files/:file_id",
            axum::routing::patch(update_file).delete(delete_file),
        )
        .route("/api/builds/:id/sync-to-panel", post(sync_to_panel))
        .route(
            "/api/builds/:id/sync-to-panel/status",
            get(sync_to_panel_status),
        )
        .route("/api/build-check", get(build_check))
        .route("/api/deps-check", get(deps_check))
        .route("/api/settings/sync-stats", post(sync_stats))
        .route(
            "/api/settings/server-token/generate",
            post(generate_server_token),
        )
        .route("/api/settings/backup-status", get(backup_status))
        .route("/api/settings/backup", post(run_backup))
        .route("/api/server/telemetry", get(server_telemetry))
        .route("/api/server/logs", get(server_logs))
        .route("/api/server/logs/:id", get(server_log))
        .route(
            "/api/server/external-mod-allowlist",
            get(list_external_mod_allowlist).post(add_external_mod_allowlist),
        )
        .route(
            "/api/server/external-mod-allowlist/:id",
            axum::routing::delete(remove_external_mod_allowlist),
        )
        .route(
            "/api/server/external-mod-block-rules",
            get(list_external_mod_block_rules).post(add_external_mod_block_rule),
        )
        .route(
            "/api/server/external-mod-block-rules/:id",
            axum::routing::delete(remove_external_mod_block_rule),
        )
        .route("/api/settings/reset-fingerprint", post(reset_fingerprint))
        .route(
            "/api/builds/files/:file_id/content",
            axum::routing::put(update_file_content),
        )
        .route("/api/accounts", get(list_accounts))
        .route(
            "/api/accounts/:uuid",
            axum::routing::patch(update_account).delete(delete_account_admin),
        )
        .route("/api/accounts/:uuid/ban", post(ban_account))
        .route("/api/accounts/:uuid/unban", post(unban_account))
        .route("/api/accounts/:uuid/role", post(set_account_role))
        .route("/api/accounts/:uuid/password", post(set_account_password))
        .route(
            "/api/accounts/:uuid/telegram",
            axum::routing::delete(unlink_account_telegram).put(set_account_telegram),
        )
        .route(
            "/api/accounts/:uuid/skin",
            get(account_skin).put(update_account_skin),
        )
        .route("/api/accounts/:uuid/stats", get(account_stats))
        .route("/api/accounts/:uuid/coins", post(grant_account_coins))
        .route(
            "/api/accounts/:uuid/customization",
            get(get_account_customization),
        )
        .route("/api/accounts/:uuid/badges", put(set_account_badges))
        .route("/api/accounts/:uuid/gradients", put(set_account_gradients))
        .route("/api/accounts/:uuid/active", put(set_account_active))
        .route("/api/badges", get(list_badges).post(create_badge))
        .route(
            "/api/badges/:id",
            axum::routing::patch(update_badge).delete(delete_badge),
        )
        .route("/api/gradients", get(list_gradients).post(create_gradient))
        .route(
            "/api/gradients/:id",
            axum::routing::patch(update_gradient).delete(delete_gradient),
        )
        .route("/api/deploy-mod", post(deploy_mod))
        .route("/api/deploy-mod/status", get(deploy_mod_status))
        // --- Сезоны и релизы лаунчера ---
        .route("/api/seasons", get(list_seasons))
        .route("/api/seasons/archive", post(archive_season))
        .route("/api/seasons/archive-status", get(season_archive_status))
        .route("/api/releases", get(list_releases))
        .route("/api/launcher/channels", get(launcher_channels))
        .route("/api/releases/build-runs", get(build_runs))
        .route("/api/releases/:tag/promote", post(promote_release))
        .route("/api/releases/promote-status", get(promote_status))
        .route("/api/releases/:tag/set-latest", post(set_latest))
        .route("/api/releases/set-latest-status", get(set_latest_status))
        // --- Публичное для лаунчера ---
        .route("/news", get(news_highlight))
        .route("/news/all", get(public_news))
        .route("/public/guides", get(public_guides))
        .route("/public/guides/:slug", get(public_guide))
        .route("/public/leaderboards", get(public_leaderboards))
        .route("/public/seasons", get(public_seasons))
        .route("/public/seasons/:id/leaderboards", get(public_season_leaderboards))
        .route("/manifest", get(manifest))
        .route(
            "/authlib-injector/latest.json",
            get(authlib_injector_metadata),
        )
        .route("/authlib-injector.jar", get(authlib_injector))
        // /files раздаёт содержимое modpack_dir, но наружу должны выходить
        // только контент-адресные блобы с hex-именем: known_hosts.json
        // (SSH-отпечаток хоста панели) в том же каталоге публичным быть
        // не должен.
        .nest_service("/files", files_service(modpack_dir))
        // Общий лимит тела для всех маршрутов. Раньше здесь стояло
        // MAX_UPLOAD_BYTES (512 МБ) — и он накрывал в том числе /api/login
        // и прочие JSON-эндпоинты: аноним мог слать мегабайты мусора,
        // не проходя авторизацию (DoS-поверхность). Большой лимит нужен
        // только multipart-загрузке — он задан прямо на её маршруте выше.
        // 16 МБ хватает для JSON-тел (тексты, base64-скины ≤ ~350 КБ).
        .layer(DefaultBodyLimit::max(MAX_JSON_BODY_BYTES))
        .with_state(state)
        .layer(cors);
    let app = router;

    let addr = std::env::var("ADMIN_BIND").unwrap_or_else(|_| "127.0.0.1:8081".into());
    let listener = tokio::net::TcpListener::bind(&addr)
        .await
        .unwrap_or_else(|e| panic!("не удалось привязаться к {addr}: {e}"));
    tracing::info!("admin-server слушает на http://{addr}");

    axum::serve(
        listener,
        app.into_make_service_with_connect_info::<std::net::SocketAddr>(),
    )
    .with_graceful_shutdown(shutdown_signal())
    .await
    .expect("ошибка сервера");
}

async fn shutdown_signal() {
    let _ = tokio::signal::ctrl_c().await;
    tracing::info!("получен сигнал остановки, завершаюсь");
}

/// Повышает до роли `admin` аккаунты, перечисленные в `ADMIN_BOOTSTRAP`
/// (логины через запятую). Нужно, чтобы выдать самого первого админа: иначе
/// зайти в веб-админку и назначить роли некому. Идемпотентно — уже admin'ы
/// пропускаются, отсутствующие аккаунты логируются как предупреждение.
async fn bootstrap_admins(store: &Store) {
    let raw = match std::env::var("ADMIN_BOOTSTRAP") {
        Ok(v) if !v.trim().is_empty() => v,
        _ => return,
    };

    for username in raw.split(',').map(str::trim).filter(|s| !s.is_empty()) {
        match store.find_by_name(username).await {
            Some(account) if account.is_admin() => {
                tracing::info!(username, "bootstrap: уже admin, пропускаю");
            }
            Some(account) => match store.set_role(&account.uuid, Role::Admin).await {
                Ok(()) => tracing::info!(username, "bootstrap: роль повышена до admin"),
                Err(e) => tracing::error!(username, ?e, "bootstrap: не удалось выдать admin"),
            },
            None => tracing::warn!(
                username,
                "bootstrap: аккаунт не найден — сначала зарегистрируйте его в лаунчере"
            ),
        }
    }
}

// ───────────────────────── Ошибки ─────────────────────────

/// Единый тип ошибки HTTP-слоя.
struct ApiError {
    status: StatusCode,
    message: String,
}

impl ApiError {
    fn new(status: StatusCode, message: impl Into<String>) -> Self {
        Self {
            status,
            message: message.into(),
        }
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (
            self.status,
            Json(ErrorBody {
                error: self.message,
            }),
        )
            .into_response()
    }
}

#[derive(Serialize)]
struct ErrorBody {
    error: String,
}

// ───────────────────────── Аутентификация ─────────────────────────

#[derive(Deserialize)]
struct LoginRequest {
    username: String,
    password: String,
}

#[derive(Serialize)]
struct LoginResponse {
    token: String,
    username: String,
    uuid: String,
}

/// IP для rate-limit. Заголовки `X-Forwarded-For` / `X-Real-IP` учитываются
/// только при `TRUST_PROXY=1|true` (за reverse-proxy); иначе — `ConnectInfo`.
///
/// Из `X-Forwarded-For` берём ПОСЛЕДНИЙ элемент: nginx с
/// `$proxy_add_x_forwarded_for` дописывает реальный адрес в конец, а элементы
/// слева клиент мог подделать сам (первый элемент = спуф, обход rate-limit).
fn get_client_ip(headers: &HeaderMap, addr: std::net::SocketAddr) -> std::net::IpAddr {
    let trust_proxy = std::env::var("TRUST_PROXY")
        .map(|v| v == "1" || v.eq_ignore_ascii_case("true"))
        .unwrap_or(false);
    if trust_proxy {
        if let Some(forwarded_for) = headers.get("x-forwarded-for") {
            if let Ok(val) = forwarded_for.to_str() {
                if let Some(last_ip) = val.split(',').next_back() {
                    if let Ok(ip) = last_ip.trim().parse::<std::net::IpAddr>() {
                        return ip;
                    }
                }
            }
        }
        if let Some(real_ip) = headers.get("x-real-ip") {
            if let Ok(val) = real_ip.to_str() {
                if let Ok(ip) = val.trim().parse::<std::net::IpAddr>() {
                    return ip;
                }
            }
        }
    }
    addr.ip()
}

async fn health() -> &'static str {
    "ok"
}

/// Вход в админку: логин/пароль + обязательная роль `admin`.
async fn login(
    State(state): State<Shared>,
    headers: HeaderMap,
    ConnectInfo(addr): ConnectInfo<std::net::SocketAddr>,
    Json(req): Json<LoginRequest>,
) -> Result<Json<LoginResponse>, ApiError> {
    let ip = get_client_ip(&headers, addr);
    if state.store.check_rate_limit(ip, 5, 60) {
        return Err(ApiError::new(
            StatusCode::TOO_MANY_REQUESTS,
            "Слишком много попыток входа. Пожалуйста, попробуйте позже.",
        ));
    }
    // Единый 401 для «нет аккаунта / неверный пароль / не админ» — без oracle.
    let invalid = || ApiError::new(StatusCode::UNAUTHORIZED, "Неверный логин или пароль");

    let profile = state
        .store
        .login(&req.username, &req.password)
        .await
        .map_err(|_| invalid())?;

    let account = state
        .store
        .find_by_uuid(&profile.id)
        .await
        .ok_or_else(invalid)?;
    if account.is_banned() {
        return Err(ApiError::new(StatusCode::FORBIDDEN, "Аккаунт заблокирован"));
    }
    if !account.is_admin() {
        return Err(invalid());
    }

    let token = state
        .store
        .create_session(&profile.id)
        .await
        .map_err(internal)?;
    Ok(Json(LoginResponse {
        token,
        username: profile.name,
        uuid: profile.id,
    }))
}

async fn logout(State(state): State<Shared>, headers: HeaderMap) -> Result<StatusCode, ApiError> {
    let token = bearer_token(&headers)?;
    let _ = state.store.destroy_session(&token).await;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Serialize)]
struct MeResponse {
    username: String,
    uuid: String,
}

async fn me(State(state): State<Shared>, headers: HeaderMap) -> Result<Json<MeResponse>, ApiError> {
    let account = require_admin(&state, &headers).await?;
    Ok(Json(MeResponse {
        username: account.username,
        uuid: account.uuid,
    }))
}

// ───────────────────────── Настройки ─────────────────────────

#[derive(Serialize)]
struct SettingsDto {
    /// Привязан ли токен бота. Сам токен наружу не отдаём (секрет).
    #[serde(rename = "telegramTokenSet")]
    telegram_token_set: bool,
    /// Закэшированный username бота (`@name`), если бот уже представился.
    #[serde(
        rename = "telegramBotUsername",
        skip_serializing_if = "Option::is_none"
    )]
    telegram_bot_username: Option<String>,
    /// SFTP-хост сервера (`host` или `host:port`).
    #[serde(rename = "sftpHost", skip_serializing_if = "Option::is_none")]
    sftp_host: Option<String>,
    /// SFTP-логин.
    #[serde(rename = "sftpUsername", skip_serializing_if = "Option::is_none")]
    sftp_username: Option<String>,
    /// Установлен ли SFTP-пароль (сам пароль наружу не отдаём).
    #[serde(rename = "sftpPasswordSet")]
    sftp_password_set: bool,
    /// Путь к папке со статистикой на SFTP-сервере.
    #[serde(rename = "sftpStatsPath", skip_serializing_if = "Option::is_none")]
    sftp_stats_path: Option<String>,
    #[serde(rename = "serverTelemetryTokenSet")]
    server_telemetry_token_set: bool,
    #[serde(rename = "backupEndpoint", skip_serializing_if = "Option::is_none")]
    backup_endpoint: Option<String>,
    #[serde(rename = "backupBucket", skip_serializing_if = "Option::is_none")]
    backup_bucket: Option<String>,
    #[serde(rename = "backupRegion", skip_serializing_if = "Option::is_none")]
    backup_region: Option<String>,
    #[serde(rename = "backupPrefix", skip_serializing_if = "Option::is_none")]
    backup_prefix: Option<String>,
    #[serde(rename = "backupAccessKeySet")]
    backup_access_key_set: bool,
    #[serde(rename = "backupSecretKeySet")]
    backup_secret_key_set: bool,
    #[serde(rename = "achievementCoinReward")]
    achievement_coin_reward: i64,
    /// Установлен ли GitHub-токен (сам токен наружу не отдаём — секрет).
    #[serde(rename = "githubTokenSet")]
    github_token_set: bool,
}

async fn load_settings_dto(state: &Shared) -> Result<SettingsDto, ApiError> {
    let keys = [
        SETTING_TELEGRAM_TOKEN,
        SETTING_TELEGRAM_USERNAME,
        SETTING_SFTP_HOST,
        SETTING_SFTP_USERNAME,
        SETTING_SFTP_PASSWORD,
        SETTING_SFTP_STATS_PATH,
        store::server_telemetry::SETTING_SERVER_TELEMETRY_TOKEN,
        SETTING_BACKUP_ENDPOINT,
        SETTING_BACKUP_BUCKET,
        SETTING_BACKUP_REGION,
        SETTING_BACKUP_PREFIX,
        SETTING_BACKUP_ACCESS_KEY,
        SETTING_BACKUP_SECRET_KEY,
        SETTING_ACHIEVEMENT_COIN_REWARD,
        SETTING_GITHUB_TOKEN,
    ];
    let map = state
        .store
        .get_settings_batch(&keys)
        .await
        .map_err(internal)?;

    let get = |key: &str| -> Option<String> { map.get(key).and_then(|v| v.clone()) };

    Ok(SettingsDto {
        telegram_token_set: get(SETTING_TELEGRAM_TOKEN)
            .map(|t| !t.trim().is_empty())
            .unwrap_or(false),
        telegram_bot_username: get(SETTING_TELEGRAM_USERNAME).filter(|u| !u.trim().is_empty()),
        sftp_host: get(SETTING_SFTP_HOST).filter(|s| !s.trim().is_empty()),
        sftp_username: get(SETTING_SFTP_USERNAME).filter(|s| !s.trim().is_empty()),
        sftp_password_set: get(SETTING_SFTP_PASSWORD)
            .map(|p| !p.trim().is_empty())
            .unwrap_or(false),
        sftp_stats_path: get(SETTING_SFTP_STATS_PATH).filter(|s| !s.trim().is_empty()),
        server_telemetry_token_set: get(store::server_telemetry::SETTING_SERVER_TELEMETRY_TOKEN)
            .is_some_and(|s| !s.trim().is_empty()),
        backup_endpoint: get(SETTING_BACKUP_ENDPOINT).filter(|s| !s.trim().is_empty()),
        backup_bucket: get(SETTING_BACKUP_BUCKET).filter(|s| !s.trim().is_empty()),
        backup_region: get(SETTING_BACKUP_REGION).filter(|s| !s.trim().is_empty()),
        backup_prefix: get(SETTING_BACKUP_PREFIX).filter(|s| !s.trim().is_empty()),
        backup_access_key_set: get(SETTING_BACKUP_ACCESS_KEY).is_some_and(|s| !s.trim().is_empty()),
        backup_secret_key_set: get(SETTING_BACKUP_SECRET_KEY).is_some_and(|s| !s.trim().is_empty()),
        achievement_coin_reward: get(SETTING_ACHIEVEMENT_COIN_REWARD)
            .and_then(|value| value.parse::<i64>().ok())
            .filter(|value| (0..=1_000_000).contains(value))
            .unwrap_or(10),
        github_token_set: get(SETTING_GITHUB_TOKEN)
            .map(|t| !t.trim().is_empty())
            .unwrap_or(false),
    })
}

async fn get_settings(
    State(state): State<Shared>,
    headers: HeaderMap,
) -> Result<Json<SettingsDto>, ApiError> {
    require_admin(&state, &headers).await?;
    Ok(Json(load_settings_dto(&state).await?))
}

#[derive(Deserialize)]
struct UpdateSettingsRequest {
    #[serde(
        rename = "telegramToken",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    telegram_token: Option<String>,
    #[serde(rename = "sftpHost", default, skip_serializing_if = "Option::is_none")]
    sftp_host: Option<String>,
    #[serde(
        rename = "sftpUsername",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    sftp_username: Option<String>,
    #[serde(
        rename = "sftpPassword",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    sftp_password: Option<String>,
    #[serde(
        rename = "sftpStatsPath",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    sftp_stats_path: Option<String>,
    #[serde(rename = "backupEndpoint", default)]
    backup_endpoint: Option<String>,
    #[serde(rename = "backupBucket", default)]
    backup_bucket: Option<String>,
    #[serde(rename = "backupRegion", default)]
    backup_region: Option<String>,
    #[serde(rename = "backupPrefix", default)]
    backup_prefix: Option<String>,
    #[serde(rename = "backupAccessKey", default)]
    backup_access_key: Option<String>,
    #[serde(rename = "backupSecretKey", default)]
    backup_secret_key: Option<String>,
    #[serde(rename = "achievementCoinReward", default)]
    achievement_coin_reward: Option<i64>,
    #[serde(rename = "githubToken", default)]
    github_token: Option<String>,
}

/// Сохраняет настройки. Сейчас — токен Telegram-бота: пишем его в таблицу
/// `settings`, откуда сервис `telegram-bot` подхватывает его без рестарта.
/// При смене токена сбрасываем закэшированный username бота — он перечитает
/// его сам через `getMe`.
async fn update_settings(
    State(state): State<Shared>,
    headers: HeaderMap,
    Json(req): Json<UpdateSettingsRequest>,
) -> Result<Json<SettingsDto>, ApiError> {
    require_admin(&state, &headers).await?;

    if let Some(token) = req.telegram_token {
        let token = token.trim();
        if token.is_empty() {
            // Пустая строка — отключить бота (убрать токен и username).
            state
                .store
                .delete_setting(SETTING_TELEGRAM_TOKEN)
                .await
                .map_err(internal)?;
            state
                .store
                .delete_setting(SETTING_TELEGRAM_USERNAME)
                .await
                .map_err(internal)?;
        } else {
            state
                .store
                .set_setting(SETTING_TELEGRAM_TOKEN, token)
                .await
                .map_err(internal)?;
            // Username устарел — пусть бот перечитает его сам.
            state
                .store
                .delete_setting(SETTING_TELEGRAM_USERNAME)
                .await
                .map_err(internal)?;
        }
    }

    // SFTP: sftpHost, sftpUsername, sftpPassword (пустая строка = удалить).
    if let Some(v) = req.sftp_host {
        let v = v.trim();
        if v.is_empty() {
            state
                .store
                .delete_setting(SETTING_SFTP_HOST)
                .await
                .map_err(internal)?;
        } else {
            state
                .store
                .set_setting(SETTING_SFTP_HOST, v)
                .await
                .map_err(internal)?;
        }
    }
    if let Some(v) = req.sftp_username {
        let v = v.trim();
        if v.is_empty() {
            state
                .store
                .delete_setting(SETTING_SFTP_USERNAME)
                .await
                .map_err(internal)?;
        } else {
            state
                .store
                .set_setting(SETTING_SFTP_USERNAME, v)
                .await
                .map_err(internal)?;
        }
    }
    if let Some(v) = req.sftp_password {
        let v = v.trim();
        if v.is_empty() {
            state
                .store
                .delete_setting(SETTING_SFTP_PASSWORD)
                .await
                .map_err(internal)?;
        } else {
            state
                .store
                .set_setting(SETTING_SFTP_PASSWORD, v)
                .await
                .map_err(internal)?;
        }
    }

    if let Some(v) = req.sftp_stats_path {
        let v = v.trim();
        if v.is_empty() {
            state
                .store
                .delete_setting(SETTING_SFTP_STATS_PATH)
                .await
                .map_err(internal)?;
        } else {
            state
                .store
                .set_setting(SETTING_SFTP_STATS_PATH, v)
                .await
                .map_err(internal)?;
        }
    }

    if let Some(reward) = req.achievement_coin_reward {
        if !(0..=1_000_000).contains(&reward) {
            return Err(ApiError::new(
                StatusCode::BAD_REQUEST,
                "награда должна быть от 0 до 1 000 000 монет",
            ));
        }
        state
            .store
            .set_setting(SETTING_ACHIEVEMENT_COIN_REWARD, &reward.to_string())
            .await
            .map_err(internal)?;
    }

    for (value, key) in [
        (req.backup_endpoint, SETTING_BACKUP_ENDPOINT),
        (req.backup_bucket, SETTING_BACKUP_BUCKET),
        (req.backup_region, SETTING_BACKUP_REGION),
        (req.backup_prefix, SETTING_BACKUP_PREFIX),
        (req.backup_access_key, SETTING_BACKUP_ACCESS_KEY),
        (req.backup_secret_key, SETTING_BACKUP_SECRET_KEY),
        (req.github_token, SETTING_GITHUB_TOKEN),
    ] {
        if let Some(value) = value {
            let value = value.trim();
            if value.is_empty() {
                state.store.delete_setting(key).await.map_err(internal)?;
            } else {
                state
                    .store
                    .set_setting(key, value)
                    .await
                    .map_err(internal)?;
            }
        }
    }

    Ok(Json(load_settings_dto(&state).await?))
}

async fn generate_server_token(
    State(state): State<Shared>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, ApiError> {
    require_admin(&state, &headers).await?;
    let token: String = rand::thread_rng()
        .sample_iter(&Alphanumeric)
        .take(64)
        .map(char::from)
        .collect();
    state
        .store
        .set_setting(
            store::server_telemetry::SETTING_SERVER_TELEMETRY_TOKEN,
            &token,
        )
        .await
        .map_err(map_store)?;
    Ok(Json(serde_json::json!({ "token": token })))
}

async fn backup_config(state: &Shared) -> Result<Option<backup::Config>, ApiError> {
    let keys = [
        SETTING_BACKUP_ENDPOINT,
        SETTING_BACKUP_BUCKET,
        SETTING_BACKUP_REGION,
        SETTING_BACKUP_PREFIX,
        SETTING_BACKUP_ACCESS_KEY,
        SETTING_BACKUP_SECRET_KEY,
    ];
    let values = state
        .store
        .get_settings_batch(&keys)
        .await
        .map_err(internal)?;
    let get = |key: &str| {
        values
            .get(key)
            .and_then(Clone::clone)
            .filter(|v| !v.trim().is_empty())
    };
    let Some(endpoint) = get(SETTING_BACKUP_ENDPOINT) else {
        return Ok(None);
    };
    let Some(bucket) = get(SETTING_BACKUP_BUCKET) else {
        return Ok(None);
    };
    let Some(access_key) = get(SETTING_BACKUP_ACCESS_KEY) else {
        return Ok(None);
    };
    let Some(secret_key) = get(SETTING_BACKUP_SECRET_KEY) else {
        return Ok(None);
    };
    Ok(Some(backup::Config {
        endpoint,
        bucket,
        region: get(SETTING_BACKUP_REGION).unwrap_or_else(|| "ru-central1".to_string()),
        prefix: get(SETTING_BACKUP_PREFIX).unwrap_or_else(|| "backups/".to_string()),
        access_key,
        secret_key,
    }))
}

async fn backup_status(
    State(state): State<Shared>,
    headers: HeaderMap,
) -> Result<Json<backup::Status>, ApiError> {
    require_admin(&state, &headers).await?;
    Ok(Json(state.backup_status.lock().await.clone()))
}

async fn run_backup(
    State(state): State<Shared>,
    headers: HeaderMap,
) -> Result<(StatusCode, Json<serde_json::Value>), ApiError> {
    require_admin(&state, &headers).await?;
    if *state.backup_running.lock().await {
        return Err(ApiError::new(StatusCode::CONFLICT, "Бекап уже выполняется"));
    }
    let task_state = Arc::clone(&state);
    tokio::spawn(async move {
        if let Err(e) = start_backup(task_state, true).await {
            tracing::warn!("[backup] ручной запуск: {e}");
        }
    });
    Ok((
        StatusCode::ACCEPTED,
        Json(serde_json::json!({ "inProgress": true })),
    ))
}

async fn start_backup(state: Shared, manual: bool) -> Result<(), String> {
    {
        let mut running = state.backup_running.lock().await;
        if *running {
            return if manual {
                Err("бекап уже выполняется".to_string())
            } else {
                Ok(())
            };
        }
        *running = true;
    }
    let started = OffsetDateTime::now_utc()
        .format(&Rfc3339)
        .unwrap_or_default();
    {
        let mut status = state.backup_status.lock().await;
        status.state = "running".to_string();
        status.last_started_at = Some(started);
        status.error = None;
    }

    let result = async {
        let config = backup_config(&state)
            .await
            .map_err(|e| e.message)?
            .ok_or_else(|| "настройки Object Storage не заполнены".to_string())?;
        if !state.backup_source_dir.is_dir() {
            return Err(format!(
                "каталог источника не найден: {:?}",
                state.backup_source_dir
            ));
        }
        let (archive, size) = backup::create_archive(state.backup_source_dir.clone()).await?;
        let now = OffsetDateTime::now_utc();
        let date = now
            .format(
                &time::format_description::parse_borrowed::<1>(
                    "[year]-[month]-[day]T[hour]-[minute]-[second]Z",
                )
                .unwrap(),
            )
            .unwrap();
        let prefix = config.prefix.trim_matches('/');
        let key = if prefix.is_empty() {
            format!("data-{date}.tar.gz")
        } else {
            format!("{prefix}/data-{date}.tar.gz")
        };
        backup::upload_and_prune(&state.http, &config, archive, &key).await?;
        Ok::<(String, u64), String>((key, size))
    }
    .await;

    let mut status = state.backup_status.lock().await;
    match result {
        Ok((key, size)) => {
            status.state = "success".to_string();
            status.last_finished_at = Some(
                OffsetDateTime::now_utc()
                    .format(&Rfc3339)
                    .unwrap_or_default(),
            );
            status.last_object = Some(key);
            status.last_size_bytes = Some(size);
            status.error = None;
        }
        Err(error) => {
            status.state = if manual { "error" } else { "disabled" }.to_string();
            status.last_finished_at = Some(
                OffsetDateTime::now_utc()
                    .format(&Rfc3339)
                    .unwrap_or_default(),
            );
            status.error = Some(error.clone());
            if manual {
                tracing::warn!("[backup] {error}");
            }
        }
    }
    *state.backup_running.lock().await = false;
    Ok(())
}

// ───────────────────────── Сборки ─────────────────────────

#[derive(Serialize)]
struct BuildHeaderDto {
    id: i64,
    name: String,
    version: String,
    #[serde(rename = "loaderKind")]
    loader_kind: String,
    #[serde(rename = "mcVersion")]
    mc_version: String,
    #[serde(rename = "loaderVersion")]
    loader_version: String,
    #[serde(rename = "isActive")]
    is_active: bool,
}

impl From<store::BuildHeader> for BuildHeaderDto {
    fn from(h: store::BuildHeader) -> Self {
        Self {
            id: h.id,
            name: h.name,
            version: h.version,
            loader_kind: h.loader_kind,
            mc_version: h.mc_version,
            loader_version: h.loader_version,
            is_active: h.is_active,
        }
    }
}

#[derive(Serialize)]
struct BuildFileDto {
    id: i64,
    path: String,
    sha1: String,
    #[serde(rename = "sizeBytes")]
    size_bytes: i64,
    side: String,
    kind: String,
    overwrite: bool,
    optional: bool,
    #[serde(rename = "enabledByDefault")]
    enabled_by_default: bool,
    disabled: bool,
    #[serde(rename = "modId")]
    mod_id: Option<String>,
    #[serde(rename = "displayName")]
    display_name: Option<String>,
    description: Option<String>,
    /// Профили, в которых состоит файл; пусто = «общий».
    #[serde(default)]
    profiles: Vec<String>,
}

impl From<store::BuildFileRow> for BuildFileDto {
    fn from(f: store::BuildFileRow) -> Self {
        Self {
            id: f.id,
            path: f.path,
            sha1: f.sha1,
            size_bytes: f.size_bytes,
            side: f.side,
            kind: f.kind,
            overwrite: f.overwrite,
            optional: f.optional,
            enabled_by_default: f.enabled_by_default,
            disabled: f.disabled,
            mod_id: f.mod_id,
            display_name: f.display_name,
            description: f.description,
            profiles: f.profile_keys,
        }
    }
}

#[derive(Serialize)]
struct BuildDetailDto {
    #[serde(flatten)]
    header: BuildHeaderDto,
    files: Vec<BuildFileDto>,
    /// Профили опциональных модов сборки (пресеты для лаунчера).
    #[serde(rename = "modProfiles")]
    mod_profiles: Vec<ModProfileDto>,
}

#[derive(Serialize, Clone)]
struct ModProfileDto {
    key: String,
    name: String,
    description: Option<String>,
    #[serde(rename = "sortOrder")]
    sort_order: i32,
}

impl From<store::ModProfileRow> for ModProfileDto {
    fn from(p: store::ModProfileRow) -> Self {
        Self {
            key: p.key,
            name: p.name,
            description: p.description,
            sort_order: p.sort_order,
        }
    }
}

async fn list_builds(
    State(state): State<Shared>,
    headers: HeaderMap,
) -> Result<Json<Vec<BuildHeaderDto>>, ApiError> {
    require_admin(&state, &headers).await?;
    let builds = state.store.list_builds().await.map_err(internal)?;
    Ok(Json(builds.into_iter().map(Into::into).collect()))
}

#[derive(Deserialize)]
struct CreateBuildRequest {
    name: String,
    version: String,
    #[serde(rename = "loaderKind", default = "default_loader")]
    loader_kind: String,
    #[serde(rename = "mcVersion")]
    mc_version: String,
    #[serde(rename = "loaderVersion", default)]
    loader_version: String,
}

fn default_loader() -> String {
    "neoforge".to_string()
}

#[derive(Serialize)]
struct CreatedBuild {
    id: i64,
}

async fn create_build(
    State(state): State<Shared>,
    headers: HeaderMap,
    Json(req): Json<CreateBuildRequest>,
) -> Result<Json<CreatedBuild>, ApiError> {
    require_admin(&state, &headers).await?;
    if req.name.trim().is_empty() || req.version.trim().is_empty() {
        return Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            "Имя и версия обязательны",
        ));
    }
    let id = state
        .store
        .create_build(NewBuild {
            name: req.name,
            version: req.version,
            loader_kind: req.loader_kind,
            mc_version: req.mc_version,
            loader_version: req.loader_version,
        })
        .await
        .map_err(internal)?;
    Ok(Json(CreatedBuild { id }))
}

async fn get_build(
    State(state): State<Shared>,
    headers: HeaderMap,
    Path(id): Path<i64>,
) -> Result<Json<BuildDetailDto>, ApiError> {
    require_admin(&state, &headers).await?;
    let record = state
        .store
        .get_build(id)
        .await
        .map_err(internal)?
        .ok_or_else(|| ApiError::new(StatusCode::NOT_FOUND, "Сборка не найдена"))?;
    Ok(Json(BuildDetailDto {
        header: record.header.into(),
        files: record.files.into_iter().map(Into::into).collect(),
        mod_profiles: record.mod_profiles.into_iter().map(Into::into).collect(),
    }))
}

async fn delete_build(
    State(state): State<Shared>,
    headers: HeaderMap,
    Path(id): Path<i64>,
) -> Result<StatusCode, ApiError> {
    require_admin(&state, &headers).await?;
    state.store.delete_build(id).await.map_err(map_store)?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize)]
struct UpdateBuildRequest {
    name: String,
    version: String,
    #[serde(rename = "loaderKind", default = "default_loader")]
    loader_kind: String,
    #[serde(rename = "mcVersion")]
    mc_version: String,
    #[serde(rename = "loaderVersion", default)]
    loader_version: String,
}

async fn update_build(
    State(state): State<Shared>,
    headers: HeaderMap,
    Path(id): Path<i64>,
    Json(req): Json<UpdateBuildRequest>,
) -> Result<StatusCode, ApiError> {
    require_admin(&state, &headers).await?;
    if req.name.trim().is_empty() || req.version.trim().is_empty() {
        return Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            "Имя и версия обязательны",
        ));
    }
    state
        .store
        .update_build(
            id,
            store::UpdateBuild {
                name: req.name,
                version: req.version,
                loader_kind: req.loader_kind,
                mc_version: req.mc_version,
                loader_version: req.loader_version,
            },
        )
        .await
        .map_err(map_store)?;
    Ok(StatusCode::NO_CONTENT)
}

async fn activate_build(
    State(state): State<Shared>,
    headers: HeaderMap,
    Path(id): Path<i64>,
) -> Result<StatusCode, ApiError> {
    require_admin(&state, &headers).await?;
    state.store.set_active_build(id).await.map_err(map_store)?;
    Ok(StatusCode::NO_CONTENT)
}

/// Тело запроса клонирования: необязательное имя копии.
#[derive(Deserialize, Default)]
struct CloneBuildRequest {
    #[serde(default)]
    name: Option<String>,
}

/// Клонирует сборку со всеми файлами в новую (неактивную). Имя берётся из
/// тела запроса либо генерируется как «<имя оригинала> (копия)».
async fn clone_build(
    State(state): State<Shared>,
    headers: HeaderMap,
    Path(id): Path<i64>,
    body: Option<Json<CloneBuildRequest>>,
) -> Result<Json<CreatedBuild>, ApiError> {
    require_admin(&state, &headers).await?;

    // Имя копии: явное из запроса (если непустое) или «<оригинал> (копия)».
    let requested = body
        .and_then(|Json(b)| b.name)
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    let new_name = match requested {
        Some(name) => name,
        None => {
            let src = state
                .store
                .get_build(id)
                .await
                .map_err(internal)?
                .ok_or_else(|| ApiError::new(StatusCode::NOT_FOUND, "Сборка не найдена"))?;
            format!("{} (копия)", src.header.name)
        }
    };

    let new_id = state
        .store
        .clone_build(id, &new_name)
        .await
        .map_err(map_store)?;
    Ok(Json(CreatedBuild { id: new_id }))
}

// ───────────────────────── Архив папки ─────────────────────────

/// Лимит на суммарный размер файлов (до сжатия) в архиве одной папки:
/// архив собирается в памяти, поэтому без предела упираемся в RAM сервера.
const MAX_FOLDER_ARCHIVE_BYTES: i64 = 2 * 1024 * 1024 * 1024; // 2 ГиБ

/// `GET /api/builds/:id/folder-archive?path=<папка>` — zip со всеми файлами
/// папки. Имена внутри архива — пути относительно самой папки (без её префикса),
/// разделитель — прямой слэш. Имя архива — последний сегмент пути + `.zip`.
async fn folder_archive(
    State(state): State<Shared>,
    headers: HeaderMap,
    Path(build_id): Path<i64>,
    Query(q): Query<FolderArchiveQuery>,
) -> Result<Response, ApiError> {
    require_admin(&state, &headers).await?;

    // Пустой path — это корень `.minecraft`, выгрузка всей сборки; сейчас
    // это не поддерживаем, чтобы не собирать гигабайтные архивы случайно.
    let folder = q.path.trim().trim_matches('/');
    if folder.is_empty() {
        return Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            "Укажите путь папки (выгрузка корня .minecraft не поддерживается)",
        ));
    }
    if folder.split('/').any(|seg| seg == ".." || seg.is_empty()) {
        return Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            "Недопустимый путь папки",
        ));
    }

    let build = state
        .store
        .get_build(build_id)
        .await
        .map_err(internal)?
        .ok_or_else(|| ApiError::new(StatusCode::NOT_FOUND, "Сборка не найдена"))?;

    // Точный префикс по сегментам: `mods` не должен ловить `mods-backup`.
    let prefix = format!("{folder}/");
    let files: Vec<_> = build
        .files
        .into_iter()
        .filter(|f| f.path.starts_with(&prefix))
        .collect();
    if files.is_empty() {
        return Err(ApiError::new(
            StatusCode::NOT_FOUND,
            "В этой папке нет файлов",
        ));
    }

    // Предохранитель по памяти: сумма исходных байтов до сжатия.
    let total: i64 = files.iter().map(|f| f.size_bytes.max(0)).sum();
    if total > MAX_FOLDER_ARCHIVE_BYTES {
        return Err(ApiError::new(
            StatusCode::PAYLOAD_TOO_LARGE,
            format!(
                "Папка слишком большая для архива: {} (лимит {})",
                human_bytes(total),
                human_bytes(MAX_FOLDER_ARCHIVE_BYTES)
            ),
        ));
    }

    // Чтение блобов и Deflate до 2 ГиБ — блокирующая работа, её нельзя
    // делать на потоке tokio (как и бекап, уводим в spawn_blocking).
    let archive_state = Arc::clone(&state);
    let archive_folder = folder.to_string();
    let zip_bytes =
        tokio::task::spawn_blocking(move || build_folder_zip(&archive_state, &archive_folder, &files))
            .await
            .map_err(|e| internal(format!("задача архивации: {e}")))??;

    // Имя архива — последний сегмент пути. Для не-ASCII добавляем filename*
    // (RFC 5987), а в базовом filename оставляем только ASCII-символы.
    let last_segment = folder.rsplit('/').next().unwrap_or(folder);
    let (_ascii_name, disposition) = archive_disposition(last_segment);

    Ok((
        StatusCode::OK,
        [
            (header::CONTENT_TYPE, "application/zip"),
            (header::CONTENT_DISPOSITION, disposition.as_str()),
            // Архив собирается заново при каждом запросе — кэшировать нельзя.
            (header::CACHE_CONTROL, "no-store"),
        ],
        zip_bytes,
    )
        .into_response())
}

#[derive(Deserialize)]
struct FolderArchiveQuery {
    path: String,
}

/// Собирает zip в памяти: блобы читаются с диска по `storage_key` (sha1).
fn build_folder_zip(
    state: &AppState,
    folder: &str,
    files: &[store::BuildFileRow],
) -> Result<Vec<u8>, ApiError> {
    use std::io::Write;

    let mut zip = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
    let options = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated);

    let prefix = format!("{folder}/");
    for f in files {
        let entry_name = f.path[prefix.len()..].replace('\\', "/");
        // Путь должен указывать на файл внутри папки, но не доверяем БД
        // на слово: пустое имя или `..`-сегмент в остатке — повреждённая
        // запись. Молча пропустить нельзя (архив получился бы тихо
        // неполным), а `..` в имени записи — это zip-slip для
        // распаковщиков вроде Java ZipInputStream, которые путь не
        // проверяют. Отваливаемся с ошибкой.
        if entry_name.is_empty() || entry_name.split('/').any(|seg| seg == "..") {
            return Err(internal(format!(
                "у файла {} путь внутри папки некорректен",
                f.path
            )));
        }
        let blob = std::fs::read(state.modpack_dir.join(&f.storage_key)).map_err(|e| {
            internal(format!(
                "нет блоба {} на диске для файла {}: {e}",
                f.storage_key, f.path
            ))
        })?;
        zip.start_file(entry_name, options)
            .map_err(|e| internal(format!("zip entry {}: {e}", f.path)))?;
        zip.write_all(&blob)
            .map_err(|e| internal(format!("zip write {}: {e}", f.path)))?;
    }

    let cursor = zip
        .finish()
        .map_err(|e| internal(format!("zip finalize: {e}")))?;
    Ok(cursor.into_inner())
}

/// Возвращает (ascii-имя, значение Content-Disposition) для архива папки.
///
/// Базовый `filename` держим ASCII-safe (санитайзим всё вне печатной ASCII),
/// а оригинальное имя с юникодом отдаём в `filename*` по RFC 5987 — браузеры
/// предпочитают его, когда он есть.
fn archive_disposition(last_segment: &str) -> (String, String) {
    let ascii_name: String = last_segment
        .chars()
        .map(|c| if c.is_ascii_graphic() && c != '"' && c != '\\' { c } else { '_' })
        .collect::<String>()
        + ".zip";
    let disposition = if last_segment.is_ascii() {
        format!("attachment; filename=\"{ascii_name}\"")
    } else {
        let encoded = percent_encode_rfc5987(last_segment);
        format!("attachment; filename=\"{ascii_name}\"; filename*=UTF-8''{encoded}.zip")
    };
    (ascii_name, disposition)
}

/// Процентное кодирование по RFC 5987 (для filename*): всё вне
/// ATTR-chars (attribute-char = ALPHA / DIGIT / !#$&+-.^_`|~) кодируется.
fn percent_encode_rfc5987(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for &b in s.as_bytes() {
        let ok = b.is_ascii_alphanumeric()
            || matches!(b, b'!' | b'#' | b'$' | b'&' | b'+' | b'-' | b'.' | b'^' | b'_' | b'`' | b'|' | b'~');
        if ok {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

/// Человекочитаемый размер для сообщений об ошибках.
fn human_bytes(bytes: i64) -> String {
    let mut v = bytes as f64;
    for unit in ["Б", "КиБ", "МиБ", "ГиБ"] {
        if v < 1024.0 {
            return if unit == "Б" {
                format!("{} {unit}", v as i64)
            } else {
                format!("{v:.1} {unit}")
            };
        }
        v /= 1024.0;
    }
    format!("{v:.1} ТиБ")
}

// ───────────────────────── Загрузка файлов ─────────────────────────

/// Принимает multipart: поле `meta` (JSON с метаданными) и поле `file`
/// (содержимое). SHA-1 считаем сами, имя в хранилище = sha1.
async fn upload_file(
    State(state): State<Shared>,
    headers: HeaderMap,
    Path(build_id): Path<i64>,
    mut multipart: Multipart,
) -> Result<Json<BuildFileDto>, ApiError> {
    require_admin(&state, &headers).await?;

    // Убедимся, что сборка существует.
    if state
        .store
        .get_build(build_id)
        .await
        .map_err(internal)?
        .is_none()
    {
        return Err(ApiError::new(StatusCode::NOT_FOUND, "Сборка не найдена"));
    }

    let mut meta: Option<UploadMeta> = None;
    let mut temp_path: Option<std::path::PathBuf> = None;

    while let Some(field) = multipart
        .next_field()
        .await
        .map_err(|e| ApiError::new(StatusCode::BAD_REQUEST, format!("multipart: {e}")))?
    {
        match field.name() {
            Some("meta") => {
                let text = field
                    .text()
                    .await
                    .map_err(|e| ApiError::new(StatusCode::BAD_REQUEST, format!("meta: {e}")))?;
                meta = Some(serde_json::from_str(&text).map_err(|e| {
                    ApiError::new(StatusCode::BAD_REQUEST, format!("meta JSON: {e}"))
                })?);
            }
            Some("file") => {
                // Стримим файл на диск вместо чтения в память.
                let tp = tempfile::NamedTempFile::new_in(&state.modpack_dir)
                    .map_err(|e| internal(format!("temp file: {e}")))?;
                let mut file = tokio::fs::File::create(tp.path())
                    .await
                    .map_err(|e| internal(format!("create temp: {e}")))?;
                let mut stream = field.into_stream();
                use tokio::io::AsyncWriteExt;
                while let Some(chunk) = stream.try_next().await.map_err(|e| {
                    ApiError::new(StatusCode::BAD_REQUEST, format!("file chunk: {e}"))
                })? {
                    file.write_all(&chunk)
                        .await
                        .map_err(|e| internal(format!("write chunk: {e}")))?;
                }
                file.flush()
                    .await
                    .map_err(|e| internal(format!("flush: {e}")))?;
                drop(file);
                temp_path = Some(
                    tp.into_temp_path()
                        .keep()
                        .map_err(|e| internal(format!("keep temp: {e}")))?,
                );
            }
            _ => {}
        }
    }

    let meta = meta.ok_or_else(|| ApiError::new(StatusCode::BAD_REQUEST, "Нет поля meta"))?;
    let temp_path = temp_path.ok_or_else(|| ApiError::new(StatusCode::BAD_REQUEST, "Нет файла"))?;
    if meta.path.trim().is_empty() {
        tokio::fs::remove_file(&temp_path).await.ok();
        return Err(ApiError::new(StatusCode::BAD_REQUEST, "Пустой path"));
    }

    let path_str = meta.path.trim();
    let p = std::path::Path::new(path_str);
    for comp in p.components() {
        match comp {
            std::path::Component::Prefix(_) => {
                tokio::fs::remove_file(&temp_path).await.ok();
                return Err(ApiError::new(
                    StatusCode::BAD_REQUEST,
                    "Недопустимый префикс пути",
                ));
            }
            std::path::Component::RootDir => {
                tokio::fs::remove_file(&temp_path).await.ok();
                return Err(ApiError::new(
                    StatusCode::BAD_REQUEST,
                    "Абсолютный путь запрещен",
                ));
            }
            std::path::Component::ParentDir => {
                tokio::fs::remove_file(&temp_path).await.ok();
                return Err(ApiError::new(
                    StatusCode::BAD_REQUEST,
                    "Выход за пределы директории запрещен",
                ));
            }
            _ => {}
        }
    }

    // Вычисляем SHA-1 и размер из уже записанного файла на диске.
    let bytes = tokio::fs::read(&temp_path)
        .await
        .map_err(|e| internal(format!("read temp: {e}")))?;
    let size_bytes = bytes.len() as i64;
    let sha1 = sha1_hex(&bytes);
    drop(bytes); // освобождаем память сразу

    // Перемещаем в контент-адресное хранилище (одинаковые файлы не дублируются).
    let dest = state.modpack_dir.join(&sha1);
    if dest.exists() {
        tokio::fs::remove_file(&temp_path).await.ok();
    } else {
        tokio::fs::rename(&temp_path, &dest)
            .await
            .map_err(|e| internal(format!("rename temp: {e}")))?;
    }

    let file = store::BuildFileInput {
        path: meta.path.trim().to_string(),
        sha1: sha1.clone(),
        size_bytes,
        side: meta.side.unwrap_or_else(|| "both".to_string()),
        kind: meta.kind.unwrap_or_else(|| "mod".to_string()),
        overwrite: meta.overwrite.unwrap_or(true),
        optional: meta.optional.unwrap_or(false),
        enabled_by_default: meta.enabled_by_default.unwrap_or(true),
        disabled: false,
        mod_id: meta.mod_id,
        display_name: meta.display_name,
        description: meta.description,
        storage_key: sha1,
        profile_keys: meta.profiles.unwrap_or_default(),
    };

    let id = state
        .store
        .upsert_build_file(build_id, file.clone())
        .await
        .map_err(map_store)?;

    Ok(Json(BuildFileDto {
        id,
        path: file.path,
        sha1: file.sha1,
        size_bytes: file.size_bytes,
        side: file.side,
        kind: file.kind,
        overwrite: file.overwrite,
        optional: file.optional,
        enabled_by_default: file.enabled_by_default,
        disabled: file.disabled,
        mod_id: file.mod_id,
        display_name: file.display_name,
        description: file.description,
        profiles: file.profile_keys,
    }))
}

#[derive(Deserialize)]
struct UploadMeta {
    /// Путь относительно `.minecraft` (напр. `mods/sodium.jar`).
    path: String,
    side: Option<String>,
    kind: Option<String>,
    overwrite: Option<bool>,
    optional: Option<bool>,
    #[serde(rename = "enabledByDefault")]
    enabled_by_default: Option<bool>,
    #[serde(rename = "modId")]
    mod_id: Option<String>,
    #[serde(rename = "displayName")]
    display_name: Option<String>,
    description: Option<String>,
    /// Профили модов, в которых состоит файл (ключи); пусто/не задано — общий.
    profiles: Option<Vec<String>>,
}

#[derive(Deserialize)]
struct UpdateFileMeta {
    side: Option<String>,
    kind: Option<String>,
    overwrite: Option<bool>,
    optional: Option<bool>,
    #[serde(rename = "enabledByDefault")]
    enabled_by_default: Option<bool>,
    disabled: Option<bool>,
    /// `None` = не передано, `Some(None)` = явно null (очистить), `Some(Some(s))` = строка.
    #[serde(rename = "modId")]
    mod_id: Option<Option<String>>,
    #[serde(rename = "displayName")]
    display_name: Option<Option<String>>,
    description: Option<Option<String>>,
    /// Профили, в которых состоит файл. `None` = не менять, `Some(v)` =
    /// заменить список целиком (пустой = «общий» для всех профилей).
    profiles: Option<Vec<String>>,
}

/// Частичное обновление метаданных файла (сторона, опциональность и т.д.).
/// Содержимое и путь файла не меняются.
async fn update_file(
    State(state): State<Shared>,
    headers: HeaderMap,
    Path(file_id): Path<i64>,
    Json(patch): Json<UpdateFileMeta>,
) -> Result<Json<BuildFileDto>, ApiError> {
    require_admin(&state, &headers).await?;

    // Берём текущую строку, чтобы неуказанные поля остались прежними.
    let current = state.store.build_file(file_id).await.map_err(map_store)?;

    let meta = store::BuildFileMeta {
        side: patch.side.unwrap_or(current.side),
        kind: patch.kind.unwrap_or(current.kind),
        overwrite: patch.overwrite.unwrap_or(current.overwrite),
        optional: patch.optional.unwrap_or(current.optional),
        enabled_by_default: patch
            .enabled_by_default
            .unwrap_or(current.enabled_by_default),
        disabled: patch.disabled.unwrap_or(current.disabled),
        // None = не передано, Some(None) = очистить (null), Some(Some(s)) = строка.
        mod_id: patch
            .mod_id
            .unwrap_or(current.mod_id)
            .filter(|s| !s.trim().is_empty()),
        display_name: patch
            .display_name
            .unwrap_or(current.display_name)
            .filter(|s| !s.trim().is_empty()),
        description: patch
            .description
            .unwrap_or(current.description)
            .filter(|s| !s.trim().is_empty()),
        // None = не менять список; Some(v) = заменить целиком.
        profile_keys: patch.profiles.unwrap_or(current.profile_keys),
    };

    let row = state
        .store
        .update_build_file_meta(file_id, meta)
        .await
        .map_err(map_store)?;

    Ok(Json(BuildFileDto::from(row)))
}

#[derive(Deserialize)]
struct UpsertModProfileRequest {
    key: String,
    name: String,
    #[serde(default)]
    description: Option<String>,
    #[serde(rename = "sortOrder", default)]
    sort_order: i32,
}

/// Профили опциональных модов сборки (пресеты «Производительность»/«Качество»).
async fn list_mod_profiles(
    State(state): State<Shared>,
    headers: HeaderMap,
    Path(id): Path<i64>,
) -> Result<Json<Vec<ModProfileDto>>, ApiError> {
    require_admin(&state, &headers).await?;
    let profiles = state.store.mod_profiles(id).await.map_err(map_store)?;
    Ok(Json(profiles.into_iter().map(Into::into).collect()))
}

/// Добавляет/обновляет профиль по ключу.
async fn upsert_mod_profile(
    State(state): State<Shared>,
    headers: HeaderMap,
    Path(id): Path<i64>,
    Json(req): Json<UpsertModProfileRequest>,
) -> Result<Json<ModProfileDto>, ApiError> {
    require_admin(&state, &headers).await?;
    let key = req.key.trim().to_lowercase();
    if key.is_empty() || req.name.trim().is_empty() {
        return Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            "Ключ и имя профиля обязательны",
        ));
    }
    // Ключ попадает в URL DELETE-роута (`/mod-profiles/:key`) — символы вне
    // `[a-z0-9-]` ломают маршрутизацию и делают профиль неудаляемым.
    if !key.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-') {
        return Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            "Ключ профиля может содержать только строчные латиницу, цифры и дефис",
        ));
    }
    let profile = state
        .store
        .upsert_mod_profile(
            id,
            store::ModProfileInput {
                key,
                name: req.name.trim().to_string(),
                description: req
                    .description
                    .map(|d| d.trim().to_string())
                    .filter(|d| !d.is_empty()),
                sort_order: req.sort_order,
            },
        )
        .await
        .map_err(map_store)?;
    Ok(Json(ModProfileDto::from(profile)))
}

/// Удаляет профиль и вычищает ссылки на него из файлов сборки.
async fn delete_mod_profile(
    State(state): State<Shared>,
    headers: HeaderMap,
    Path((id, key)): Path<(i64, String)>,
) -> Result<StatusCode, ApiError> {
    require_admin(&state, &headers).await?;
    // Удаление профиля и чистка ссылок — одна транзакция внутри store.
    state
        .store
        .delete_mod_profile(id, &key)
        .await
        .map_err(map_store)?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize)]
struct UpdateContent {
    content: String,
    /// SHA-1 версии, которую редактор видел при загрузке. При несовпадении с
    /// текущей — 409: файл менялся после открытия, слепое сохранение затёрло бы
    /// чужую правку (last-write-wins). Отсутствие поля = старый клиент.
    #[serde(rename = "baseSha1", default)]
    base_sha1: Option<String>,
}

/// Заменяет содержимое текстового файла. Пересчитывает sha1, пишет новые
/// байты в контент-адресное хранилище и обновляет строку. Путь не меняется.
async fn update_file_content(
    State(state): State<Shared>,
    headers: HeaderMap,
    Path(file_id): Path<i64>,
    Json(body): Json<UpdateContent>,
) -> Result<Json<BuildFileDto>, ApiError> {
    require_admin(&state, &headers).await?;

    let current = state.store.build_file(file_id).await.map_err(map_store)?;
    if let Some(base) = body.base_sha1.as_deref().filter(|b| !b.is_empty()) {
        if !base.eq_ignore_ascii_case(&current.sha1) {
            return Err(ApiError::new(
                StatusCode::CONFLICT,
                "Файл был изменён после того, как вы его открыли. Обновите редактор и перенесите правки.",
            ));
        }
    }

    let bytes = body.content.into_bytes();
    let sha1 = sha1_hex(&bytes);
    let size_bytes = bytes.len() as i64;

    let dest = state.modpack_dir.join(&sha1);
    if !dest.exists() {
        tokio::fs::write(&dest, &bytes)
            .await
            .map_err(|e| internal(format!("запись файла: {e}")))?;
    }

    let row = state
        .store
        .update_build_file_content(file_id, sha1.clone(), size_bytes, sha1)
        .await
        .map_err(map_store)?;

    Ok(Json(BuildFileDto::from(row)))
}

async fn delete_file(
    State(state): State<Shared>,
    headers: HeaderMap,
    Path(file_id): Path<i64>,
) -> Result<StatusCode, ApiError> {
    require_admin(&state, &headers).await?;
    state
        .store
        .delete_build_file(file_id)
        .await
        .map_err(map_store)?;
    Ok(StatusCode::NO_CONTENT)
}

// ───────────────────────── Синхронизация по SFTP ─────────────────────────

#[derive(Serialize)]
struct SyncResult {
    uploaded: usize,
    skipped: usize,
    deleted: usize,
    #[serde(rename = "inProgress")]
    in_progress: bool,
}

#[derive(Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct SyncStatus {
    build_id: Option<i64>,
    state: SyncState,
    phase: String,
    current: usize,
    total: usize,
    uploaded: usize,
    skipped: usize,
    deleted: usize,
    error: Option<String>,
    started_at: Option<String>,
    finished_at: Option<String>,
}

#[derive(Clone, Default, Serialize)]
#[serde(rename_all = "snake_case")]
enum SyncState {
    #[default]
    Idle,
    Running,
    Success,
    Error,
}

impl SyncStatus {
    fn started(build_id: i64) -> Self {
        Self {
            build_id: Some(build_id),
            state: SyncState::Running,
            phase: "Подготовка".to_string(),
            started_at: Some(
                OffsetDateTime::now_utc()
                    .format(&Rfc3339)
                    .unwrap_or_default(),
            ),
            ..Self::default()
        }
    }
}

async fn update_sync_status(state: &Shared, update: impl FnOnce(&mut SyncStatus)) {
    let mut status = state.sync_to_panel_status.lock().await;
    update(&mut status);
}

/// Имя манифеста синхронизации на стороне сервера. По нему при следующей
/// синхронизации мы понимаем, какие файлы заливали раньше, и удаляем те,
/// что были убраны из сборки (как `managed-files.json` в лаунчере).
const SYNC_MANIFEST: &str = ".stardust-sync.json";

/// SSH client handler. Хранит known hosts в файле `known_hosts.json` рядом с
/// modpack-dir, отпечатки — по ключу `host:port` (смена хоста в настройках не
/// ложно блокируется чужим отпечатком). При первом подключении ключ хоста
/// сохраняется; при последующих — проверяется. Если файл отсутствует или пуст —
/// ключ принимается и записывается (первое подключение = доверие). Смена ключа
/// хоста = ошибка (возможная MITM-атака). Для совместимости старый формат
/// `{"host_key": fp}` трактуется как отпечаток неизвестно какого хоста и
/// игнорируется (перезапишется при первом коннекте).
struct SftpHandler {
    /// Путь к файлу known_hosts.json.
    known_hosts_path: std::path::PathBuf,
    /// Идентификатор подключаемого хоста (`host:port`).
    host_id: String,
}

impl SftpHandler {
    fn new(modpack_dir: &std::path::Path, host_id: &str) -> Self {
        Self {
            known_hosts_path: modpack_dir.join("known_hosts.json"),
            host_id: host_id.to_string(),
        }
    }

    /// Читает known hosts из файла.
    fn load_hosts(&self) -> std::collections::BTreeMap<String, String> {
        std::fs::read_to_string(&self.known_hosts_path)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default()
    }

    /// Сохраняет known hosts в файл.
    fn save_hosts(&self, hosts: &std::collections::BTreeMap<String, String>) {
        if let Ok(json) = serde_json::to_string_pretty(hosts) {
            let _ = std::fs::write(&self.known_hosts_path, json);
        }
    }
}

impl russh::client::Handler for SftpHandler {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        key: &russh::keys::ssh_key::PublicKey,
    ) -> Result<bool, Self::Error> {
        // Fingerprint ключа для сравнения (стабильный формат).
        let key_str = key
            .fingerprint(russh::keys::ssh_key::HashAlg::Sha256)
            .to_string();

        // Проверяем known hosts.
        let mut hosts = self.load_hosts();
        let host_key = hosts.get(&self.host_id);

        match host_key {
            Some(known) if known == &key_str => {
                // Ключ совпал — хост известен и доверен.
                Ok(true)
            }
            Some(_mismatch) => {
                // Ключ изменился — потенциальная MITM-атака.
                tracing::error!(
                    "[sftp] КЛЮЧ ХОСТА ИЗМЕНИЛСЯ для {}! Возможна MITM-атака. \
                     Удалите known_hosts.json и подключитесь заново, \
                     если вы уверены в безопасности канала.",
                    self.host_id
                );
                Err(russh::Error::UnknownKey)
            }
            None => {
                // Первое подключение — сохраняем ключ.
                tracing::info!("[sftp] Первое подключение, сохраняем ключ хоста");
                hosts.insert(self.host_id.clone(), key_str);
                self.save_hosts(&hosts);
                Ok(true)
            }
        }
    }
}

/// Публичная раздача `modpack_dir` под `/files`. Это тот же каталог, где
/// живут служебные файлы (known_hosts.json с SSH-отпечатком хоста панели),
/// поэтому отдаём наружу только имена, валидные как SHA-1-ключ контентного
/// хранилища: 40 символов `[0-9a-f]`. Остальное — 404.
fn files_service(modpack_dir: PathBuf) -> Router {
    async fn guard(req: axum::extract::Request, next: Next) -> Response {
        let path = req.uri().path();
        // `/files/<name>` или `/files/<name>/...` (ServeDir может слать
        // вложенные пути — их отсекаем той же проверкой сегмента).
        let rest = path.trim_start_matches("/files/").trim_start_matches('/');
        let name = rest.split('/').next().unwrap_or("");
        let is_hex40 = name.len() == 40
            && name
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b));
        if !rest.is_empty() && !is_hex40 {
            return (StatusCode::NOT_FOUND, "файл не найден").into_response();
        }
        next.run(req).await
    }
    Router::new()
        .nest_service("/", ServeDir::new(modpack_dir))
        .layer(middleware::from_fn(guard))
}

/// Удаляет known_hosts.json — сбрасывает отпечаток SSH-ключа сервера.
/// При следующем подключении ключ будет принят заново.
async fn reset_fingerprint(
    State(state): State<Shared>,
    headers: HeaderMap,
) -> Result<StatusCode, ApiError> {
    require_admin(&state, &headers).await?;

    let path = state.modpack_dir.join("known_hosts.json");
    match std::fs::remove_file(&path) {
        Ok(()) => {
            tracing::info!("[sftp] known_hosts.json удалён — отпечаток сброшен");
            Ok(StatusCode::NO_CONTENT)
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            tracing::info!("[sftp] known_hosts.json уже отсутствовал");
            Ok(StatusCode::NO_CONTENT)
        }
        Err(e) => Err(ApiError::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("Не удалось удалить known_hosts.json: {e}"),
        )),
    }
}

async fn sync_to_panel(
    State(state): State<Shared>,
    headers: HeaderMap,
    Path(build_id): Path<i64>,
) -> Result<(StatusCode, Json<SyncResult>), ApiError> {
    require_admin(&state, &headers).await?;

    {
        let mut running = state.sync_to_panel_running.lock().await;
        if let Some(active_build_id) = *running {
            return Err(ApiError::new(
                StatusCode::CONFLICT,
                format!("SFTP-синхронизация уже выполняется для сборки #{active_build_id}"),
            ));
        }
        *running = Some(build_id);
    }
    update_sync_status(&state, |status| *status = SyncStatus::started(build_id)).await;

    let task_state = Arc::clone(&state);
    tokio::spawn(async move {
        match do_sync_to_panel(Arc::clone(&task_state), build_id).await {
            Ok(result) => {
                update_sync_status(&task_state, |status| {
                    status.state = SyncState::Success;
                    status.phase = "Готово".to_string();
                    status.current = status.total;
                    status.uploaded = result.uploaded;
                    status.skipped = result.skipped;
                    status.deleted = result.deleted;
                    status.error = None;
                    status.finished_at = Some(
                        OffsetDateTime::now_utc()
                            .format(&Rfc3339)
                            .unwrap_or_default(),
                    );
                })
                .await;
                tracing::info!(
                    build_id,
                    uploaded = result.uploaded,
                    skipped = result.skipped,
                    deleted = result.deleted,
                    "[sftp] синхронизация завершена"
                );
            }
            Err(err) => {
                update_sync_status(&task_state, |status| {
                    status.state = SyncState::Error;
                    status.phase = "Ошибка".to_string();
                    status.error = Some(err.message.clone());
                    status.finished_at = Some(
                        OffsetDateTime::now_utc()
                            .format(&Rfc3339)
                            .unwrap_or_default(),
                    );
                })
                .await;
                tracing::error!(
                    build_id,
                    status = %err.status,
                    error = %err.message,
                    "[sftp] синхронизация завершилась ошибкой"
                );
            }
        }

        let mut running = task_state.sync_to_panel_running.lock().await;
        if *running == Some(build_id) {
            *running = None;
        }
    });

    Ok((
        StatusCode::ACCEPTED,
        Json(SyncResult {
            uploaded: 0,
            skipped: 0,
            deleted: 0,
            in_progress: true,
        }),
    ))
}

async fn sync_to_panel_status(
    State(state): State<Shared>,
    headers: HeaderMap,
    Path(build_id): Path<i64>,
) -> Result<Json<SyncStatus>, ApiError> {
    require_admin(&state, &headers).await?;
    let status = state.sync_to_panel_status.lock().await.clone();
    if status.build_id == Some(build_id) {
        Ok(Json(status))
    } else {
        Ok(Json(SyncStatus::default()))
    }
}

async fn do_sync_to_panel(state: Shared, build_id: i64) -> Result<SyncResult, ApiError> {
    let host = state
        .store
        .get_setting(SETTING_SFTP_HOST)
        .await
        .map_err(internal)?
        .filter(|s| !s.trim().is_empty())
        .ok_or_else(|| ApiError::new(StatusCode::BAD_REQUEST, "sftpHost не задан"))?;
    let username = state
        .store
        .get_setting(SETTING_SFTP_USERNAME)
        .await
        .map_err(internal)?
        .filter(|s| !s.trim().is_empty())
        .ok_or_else(|| ApiError::new(StatusCode::BAD_REQUEST, "sftpUsername не задан"))?;
    let password = state
        .store
        .get_setting(SETTING_SFTP_PASSWORD)
        .await
        .map_err(internal)?
        .filter(|s| !s.trim().is_empty())
        .ok_or_else(|| ApiError::new(StatusCode::BAD_REQUEST, "sftpPassword не задан"))?;

    let build = state
        .store
        .get_build(build_id)
        .await
        .map_err(internal)?
        .ok_or_else(|| ApiError::new(StatusCode::NOT_FOUND, "сборка не найдена"))?;

    // host или host:port → нормализуем в (host, port).
    let (host_part, port) = match host.rsplit_once(':') {
        Some((h, p)) => match p.parse::<u16>() {
            Ok(port) => (h.to_string(), port),
            // двоеточие без числа (например, IPv6 без порта) — берём как есть.
            Err(_) => (host.clone(), 22),
        },
        None => (host.clone(), 22),
    };

    // Устанавливаем SSH-сессию и аутентифицируемся паролем.
    let config = Arc::new(russh::client::Config::default());
    let mut session = russh::client::connect(
        config,
        (host_part.as_str(), port),
        SftpHandler::new(&state.modpack_dir, &format!("{host_part}:{port}")),
    )
    .await
    .map_err(|e| internal(format!("SSH-подключение к {host_part}:{port}: {e}")))?;
    let auth = session
        .authenticate_password(&username, &password)
        .await
        .map_err(|e| internal(format!("SSH-аутентификация: {e}")))?;
    if !auth.success() {
        return Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            "SFTP-аутентификация не прошла: проверьте логин/пароль",
        ));
    }

    let channel = session
        .channel_open_session()
        .await
        .map_err(|e| internal(format!("открытие канала: {e}")))?;
    channel
        .request_subsystem(true, "sftp")
        .await
        .map_err(|e| internal(format!("запуск sftp-подсистемы: {e}")))?;
    let sftp = russh_sftp::client::SftpSession::new(channel.into_stream())
        .await
        .map_err(|e| internal(format!("инициализация SFTP: {e}")))?;

    // Манифест прошлой синхронизации: { путь -> sha1 } того, что мы заливали.
    // По нему удаляем файлы, убранные из сборки. Если файла нет/он битый —
    // считаем, что синхронизаций ещё не было.
    let previous: std::collections::BTreeMap<String, String> = match sftp.read(SYNC_MANIFEST).await
    {
        Ok(bytes) => serde_json::from_slice(&bytes).unwrap_or_default(),
        Err(_) => std::collections::BTreeMap::new(),
    };

    let mut uploaded = 0usize;
    let mut skipped = 0usize;
    let mut deleted = 0usize;
    let mut current = 0usize;
    let total = build.files.len() + previous.len() + 1;
    update_sync_status(&state, |status| {
        status.phase = "Загрузка файлов".to_string();
        status.current = 0;
        status.total = total.max(1);
    })
    .await;
    // Что должно лежать на сервере после этой синхронизации: { путь -> sha1 }.
    let mut desired: std::collections::BTreeMap<String, String> = std::collections::BTreeMap::new();

    for file in &build.files {
        update_sync_status(&state, |status| {
            status.phase = format!("Загрузка {}", file.path);
            status.current = current;
            status.total = total.max(1);
            status.uploaded = uploaded;
            status.skipped = skipped;
            status.deleted = deleted;
        })
        .await;

        // Грузим всё, что нужно серверу (side = server | both), независимо от
        // опциональности и «включён по умолчанию» — опц. моды тоже едут.
        // Отключённые файлы пропускаем — они не должны отдаваться ни клиенту, ни серверу.
        if file.disabled || (file.side != "server" && file.side != "both") {
            skipped += 1;
            current += 1;
            continue;
        }

        // Целевой путь на сервере = относительный путь файла из сборки.
        let target = file.path.trim_start_matches('/').to_string();

        // ─── Skip unchanged: если файл в манифесте с тем же SHA-1 и
        // удалённый файл существует — пропускаем загрузку. ───
        if let Some(prev_sha1) = previous.get(&target) {
            if prev_sha1.eq_ignore_ascii_case(&file.sha1) {
                // Проверяем, что файл реально есть на сервере.
                match sftp.metadata(&target).await {
                    Ok(_meta) => {
                        // Файл на месте и хеш совпадает — пропускаем.
                        desired.insert(target, file.sha1.clone());
                        skipped += 1;
                        current += 1;
                        continue;
                    }
                    Err(_) => {
                        // Файла нет на сервере (удалён вручную) — перезаливаем.
                    }
                }
            }
        }

        // Создаём родительские директории по цепочке.
        if let Some(parent) = std::path::Path::new(&target).parent() {
            let mut acc = String::new();
            for comp in parent.components() {
                let comp = comp.as_os_str().to_string_lossy();
                if comp.is_empty() {
                    continue;
                }
                if !acc.is_empty() {
                    acc.push('/');
                }
                acc.push_str(&comp);
                // Игнорируем ошибку «уже существует».
                let _ = sftp.create_dir(&acc).await;
            }
        }

        // Читаем файл с диска и заливаем.
        let file_path = state.modpack_dir.join(&file.storage_key);
        let bytes = tokio::fs::read(&file_path)
            .await
            .map_err(|e| internal(format!("чтение файла {}: {e}", file.path)))?;

        write_sftp_file_atomic(&sftp, &target, &bytes).await?;

        desired.insert(target, file.sha1.clone());
        uploaded += 1;
        current += 1;
    }

    // Удаляем то, что заливали раньше, но в текущей сборке этого уже нет.
    // Удаляем только если содержимое на сервере не менялось с момента нашей
    // заливки (sha1 совпадает с записанным) — чтобы не затирать правки админа
    // сервера. Сам манифест синхронизации не трогаем.
    for (path, recorded_sha1) in &previous {
        update_sync_status(&state, |status| {
            status.phase = format!("Проверка удаления {path}");
            status.current = current;
            status.total = total.max(1);
            status.uploaded = uploaded;
            status.skipped = skipped;
            status.deleted = deleted;
        })
        .await;

        if desired.contains_key(path) || path == SYNC_MANIFEST {
            current += 1;
            continue;
        }
        let unchanged = match sftp.read(path).await {
            Ok(bytes) => sha1_hex(&bytes).eq_ignore_ascii_case(recorded_sha1),
            // Файла уже нет на сервере — удалять нечего.
            Err(_) => false,
        };
        if unchanged && sftp.remove_file(path).await.is_ok() {
            deleted += 1;
        }
        current += 1;
    }

    // Сохраняем новый манифест синхронизации на сервере.
    update_sync_status(&state, |status| {
        status.phase = "Запись манифеста".to_string();
        status.current = current;
        status.total = total.max(1);
        status.uploaded = uploaded;
        status.skipped = skipped;
        status.deleted = deleted;
    })
    .await;
    let manifest_bytes = serde_json::to_vec(&desired)
        .map_err(|e| internal(format!("сериализация манифеста: {e}")))?;
    write_sftp_file_atomic(&sftp, SYNC_MANIFEST, &manifest_bytes).await?;
    current += 1;
    update_sync_status(&state, |status| {
        status.current = current;
        status.total = total.max(1);
        status.uploaded = uploaded;
        status.skipped = skipped;
        status.deleted = deleted;
    })
    .await;

    // Корректно завершаем SSH-сессию.
    let _ = session
        .disconnect(russh::Disconnect::ByApplication, "", "en")
        .await;

    Ok(SyncResult {
        uploaded,
        skipped,
        deleted,
        in_progress: false,
    })
}

async fn write_sftp_file_atomic(
    sftp: &russh_sftp::client::SftpSession,
    target: &str,
    bytes: &[u8],
) -> Result<(), ApiError> {
    use russh_sftp::protocol::OpenFlags;
    use tokio::io::AsyncWriteExt;

    let tmp = format!(
        "{target}.stardust-upload-{}-{}.tmp",
        std::process::id(),
        OffsetDateTime::now_utc().unix_timestamp_nanos()
    );

    let write_result = async {
        let mut remote = sftp
            .open_with_flags(
                &tmp,
                OpenFlags::CREATE | OpenFlags::WRITE | OpenFlags::TRUNCATE,
            )
            .await
            .map_err(|e| internal(format!("открытие временного файла {tmp} на сервере: {e}")))?;

        // SFTP-серверы часто ограничивают размер WRITE-пакета примерно 32 КБ.
        const SFTP_CHUNK: usize = 30 * 1024;
        for chunk in bytes.chunks(SFTP_CHUNK) {
            remote
                .write_all(chunk)
                .await
                .map_err(|e| internal(format!("запись временного файла {tmp}: {e}")))?;
        }
        remote
            .shutdown()
            .await
            .map_err(|e| internal(format!("закрытие временного файла {tmp}: {e}")))?;

        Ok::<(), ApiError>(())
    }
    .await;

    if let Err(err) = write_result {
        let _ = sftp.remove_file(&tmp).await;
        return Err(err);
    }

    if let Err(first_err) = sftp.rename(&tmp, target).await {
        // Некоторые SFTP-серверы не заменяют существующий файл через rename.
        // Временный файл уже полностью записан, поэтому целевой путь трогаем
        // только перед финальным rename, а не в начале загрузки.
        let _ = sftp.remove_file(target).await;
        if let Err(second_err) = sftp.rename(&tmp, target).await {
            let _ = sftp.remove_file(&tmp).await;
            return Err(internal(format!(
                "атомарная замена {target}: {first_err}; повтор после удаления: {second_err}"
            )));
        }
    }

    Ok(())
}

// ───────────────────── Сезоны и релизы лаунчера ─────────────────────

/// Статус фоновой архивации сезона (polling из админки).
#[derive(Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct SeasonArchiveStatus {
    /// `idle` | `running` | `success` | `error`.
    state: SyncState,
    season_id: Option<i32>,
    season_name: Option<String>,
    phase: String,
    error: Option<String>,
    started_at: Option<String>,
    finished_at: Option<String>,
}

/// Статус фонового продвижения релиза в stable (polling из админки).
#[derive(Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct PromoteStatus {
    /// `idle` | `running` | `success` | `error`.
    state: SyncState,
    tag: Option<String>,
    phase: String,
    error: Option<String>,
    started_at: Option<String>,
    finished_at: Option<String>,
}

/// Статус фонового перенаправления канала на релиз (polling из админки).
#[derive(Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct SetLatestStatus {
    /// `idle` | `running` | `success` | `error`.
    state: SyncState,
    /// Канал: `beta` | `stable`.
    channel: Option<String>,
    /// Тег, на который направляется канал.
    tag: Option<String>,
    phase: String,
    error: Option<String>,
    started_at: Option<String>,
    finished_at: Option<String>,
}

/// `GET /api/seasons` — все сезоны, от новых к старым.
async fn list_seasons(
    State(state): State<Shared>,
    headers: HeaderMap,
) -> Result<Json<Vec<SeasonRow>>, ApiError> {
    require_admin(&state, &headers).await?;
    let seasons = state.store.list_seasons().await.map_err(map_store)?;
    Ok(Json(seasons))
}

/// `GET /api/seasons/archive-status` — статус архивации.
async fn season_archive_status(
    State(state): State<Shared>,
    headers: HeaderMap,
) -> Result<Json<SeasonArchiveStatus>, ApiError> {
    require_admin(&state, &headers).await?;
    Ok(Json(state.season_archive_status.lock().await.clone()))
}

/// `POST /api/seasons/archive` — архивировать активный сезон в фоне.
/// Подтверждение (confirm-диалог) живёт на фронтенде; бэкенд просто делает.
async fn archive_season(
    State(state): State<Shared>,
    headers: HeaderMap,
) -> Result<(StatusCode, Json<serde_json::Value>), ApiError> {
    require_admin(&state, &headers).await?;

    // Старый сезон нужен сразу: по его id считается имя следующего. Запрос
    // делаем ДО установки флага running: на этом пути можно упасть с
    // ошибкой до tokio::spawn, и флаг, поставленный раньше, уже никто
    // не сбросил бы — все последующие POST навсегда получили бы 409.
    let active = state
        .store
        .active_season()
        .await
        .map_err(map_store)?
        .ok_or_else(|| {
            ApiError::new(StatusCode::NOT_FOUND, "Нет активного сезона в базе данных")
        })?;

    {
        let mut running = state.season_archive_running.lock().await;
        if *running {
            return Err(ApiError::new(
                StatusCode::CONFLICT,
                "Архивация сезона уже выполняется",
            ));
        }
        *running = true;
    }

    {
        let mut status = state.season_archive_status.lock().await;
        *status = SeasonArchiveStatus {
            state: SyncState::Running,
            season_id: Some(active.id),
            season_name: Some(active.name.clone()),
            phase: "Снимок статистики игроков".to_string(),
            started_at: Some(
                OffsetDateTime::now_utc()
                    .format(&Rfc3339)
                    .unwrap_or_default(),
            ),
            ..Default::default()
        };
    }

    let next_name = format!("Сезон {}", active.id + 1);
    let task_state = Arc::clone(&state);
    tokio::spawn(async move {
        let result: Result<SeasonRow, String> = async {
            update_season_archive_status(&task_state, |s| {
                s.phase = "Снимок статистики игроков".to_string()
            })
            .await;
            // Все шаги ниже выполняются одной транзакцией внутри store;
            // фазы отражают логический прогресс для UI.
            let new_season = task_state
                .store
                .archive_active_season(&next_name)
                .await
                .map_err(|e| e.to_string())?;
            update_season_archive_status(&task_state, |s| {
                s.phase = "Закрытие сезона".to_string()
            })
            .await;
            update_season_archive_status(&task_state, |s| {
                s.phase = "Открытие нового сезона".to_string()
            })
            .await;
            update_season_archive_status(&task_state, |s| {
                s.phase = "Обнуление счётчиков".to_string()
            })
            .await;
            Ok(new_season)
        }
        .await;

        let mut status = task_state.season_archive_status.lock().await;
        match result {
            Ok(new_season) => {
                status.state = SyncState::Success;
                status.season_id = Some(new_season.id);
                status.season_name = Some(new_season.name.clone());
                status.phase = format!("Готово: открыт {}", new_season.name);
                status.error = None;
            }
            Err(error) => {
                status.state = SyncState::Error;
                status.phase = "Ошибка".to_string();
                status.error = Some(error.clone());
                tracing::warn!("seasons-archive: {error}");
            }
        }
        status.finished_at = Some(
            OffsetDateTime::now_utc()
                .format(&Rfc3339)
                .unwrap_or_default(),
        );
        *task_state.season_archive_running.lock().await = false;
    });

    Ok((
        StatusCode::ACCEPTED,
        Json(serde_json::json!({ "inProgress": true })),
    ))
}

async fn update_season_archive_status(
    state: &Shared,
    update: impl FnOnce(&mut SeasonArchiveStatus),
) {
    let mut status = state.season_archive_status.lock().await;
    update(&mut status);
}

// ───────────────────── Релизы лаунчера (GitHub) ─────────────────────

/// Репозиторий, в котором живут релизы лаунчера и алиасы апдейтера.
const GITHUB_REPO: &str = "Zeragorn-ru/stardust";

/// Строгая проверка тега релиза лаунчера. Тег попадает в path URL
/// `api.github.com/repos/.../releases/tags/{tag}` с токеном, поэтому
/// недостаточно `starts_with('v')`: точка и слэш позволяют уводить запрос
/// на произвольный путь GitHub (dot-segment). Разрешаем `vцифры.цифры.цифры`
/// и fix-релизы поверх базовой версии — `vцифры.цифры.цифры-fixцифры`.
fn tag_is_release(tag: &str) -> bool {
    let rest = tag.strip_prefix('v').unwrap_or("");
    // Отделяем суффикс -fixN (если есть) до разбора сегментов.
    let (base, fix) = match rest.split_once("-fix") {
        Some((b, n)) => (b, Some(n)),
        None => (rest, None),
    };
    if let Some(n) = fix {
        if n.is_empty() || !n.bytes().all(|b| b.is_ascii_digit()) {
            return false;
        }
    }
    let mut parts = base.split('.');
    let mut ok = !base.is_empty();
    for _ in 0..3 {
        let seg = parts.next().unwrap_or("");
        ok &= !seg.is_empty() && seg.bytes().all(|b| b.is_ascii_digit());
    }
    ok && parts.next().is_none()
}
/// Тег алиаса, из которого stable-клиенты качают latest.json.
const STABLE_ALIAS_TAG: &str = "launcher-stable";
/// Тег алиаса, из которого beta-клиенты качают latest.json.
const BETA_ALIAS_TAG: &str = "launcher-beta";
/// Имя workflow, который собирает релизы лаунчера по тегу.
const LAUNCHER_WORKFLOW_NAME: &str = "launcher-release";
/// Каналы апдейтера, известные админке.
const UPDATE_CHANNELS: [&str; 2] = ["beta", "stable"];

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ReleaseDto {
    tag: String,
    name: Option<String>,
    prerelease: bool,
    published_at: Option<String>,
}

/// Прогон workflow launcher-release по тегу — «собирается сейчас».
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct BuildRunDto {
    /// Тег, по которому запущен прогон (head_branch для тегового push).
    tag: String,
    /// `queued` | `running` | `success` | `failure` | `cancelled`.
    state: String,
    /// Идентификатор прогона для ссылки на GitHub.
    run_id: i64,
    /// RFC 3339 старта.
    started_at: Option<String>,
    /// Состояние платформ-leg матрицы (windows/linux/macos).
    legs: Vec<BuildLegDto>,
}

/// Состояние одной платформы-leg матрицы сборки.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct BuildLegDto {
    /// `windows` | `linux` | `macos` (id матрицы).
    platform: String,
    /// `queued` | `running` | `success` | `failure` | `cancelled`.
    state: String,
}

/// Нормализация статусов jobs/runs GitHub Actions в один вид.
fn gh_actions_state(status: &str, conclusion: Option<&str>) -> String {
    match (status, conclusion) {
        ("completed", Some("success")) => "success".to_string(),
        ("completed", Some("cancelled")) => "cancelled".to_string(),
        ("completed", _) => "failure".to_string(),
        ("in_progress", _) => "running".to_string(),
        _ => "queued".to_string(),
    }
}

/// Состояние канала апдейтера для «пульта каналов» в админке.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct LauncherChannelDto {
    /// `beta` | `stable`.
    channel: String,
    /// Тег, который канал раздаёт, или null — алиас ещё не создан.
    tag: Option<String>,
    /// RFC 3339 публикации последнего latest.json в алиасе.
    updated_at: Option<String>,
}

/// Читает тег и время из latest.json алиаса канала. Отсутствие алиаса —
/// не ошибка: канал ещё не настроен (null).
async fn read_alias_channel(
    state: &Shared,
    token: &str,
    channel: &str,
) -> Result<LauncherChannelDto, String> {
    let alias_tag = match channel {
        "beta" => BETA_ALIAS_TAG,
        "stable" => STABLE_ALIAS_TAG,
        _ => return Err(format!("неизвестный канал {channel}")),
    };
    let dto = LauncherChannelDto {
        channel: channel.to_string(),
        tag: None,
        updated_at: None,
    };

    let alias_url =
        format!("https://api.github.com/repos/{GITHUB_REPO}/releases/tags/{alias_tag}");
    let resp = github_api(state, reqwest::Method::GET, &alias_url, token, GH_ACCEPT_V3, None).await?;
    if resp.status() == reqwest::StatusCode::NOT_FOUND {
        return Ok(dto);
    }
    if !resp.status().is_success() {
        return Err(format!(
            "получение алиаса {alias_tag}: HTTP {} (проверьте GitHub токен)",
            resp.status().as_u16()
        ));
    }
    let alias: GitHubRelease = resp
        .json()
        .await
        .map_err(|e| format!("парсинг алиаса {alias_tag}: {e}"))?;

    // Время канала — время публикации latest.json (asset updated_at).
    let Some(asset) = alias.assets.iter().find(|a| a.name == "latest.json") else {
        return Ok(dto);
    };
    let latest_bytes = fetch_release_asset(
        state,
        &asset.browser_download_url,
        &format!("latest.json {alias_tag}"),
    )
    .await?;
    let latest: serde_json::Value = serde_json::from_slice(&latest_bytes)
        .map_err(|e| format!("latest.json {alias_tag} не парсится: {e}"))?;
    // CI кладёт в latest.json версию без префикса v (set-version срезает его),
    // а релизы в админке живут тегами vX.Y.Z — нормализуем к тегу.
    let version = latest
        .get("version")
        .and_then(|v| v.as_str())
        .map(|v| if v.starts_with('v') { v.to_string() } else { format!("v{v}") });

    Ok(LauncherChannelDto {
        channel: channel.to_string(),
        tag: version,
        updated_at: asset.updated_at.clone(),
    })
}

/// `GET /api/launcher/channels` — состояние каналов апдейтера: какой тег
/// раздаёт beta/stable и когда канал обновлялся. Для «пульта каналов».
async fn launcher_channels(
    State(state): State<Shared>,
    headers: HeaderMap,
) -> Result<Json<Vec<LauncherChannelDto>>, ApiError> {
    require_admin(&state, &headers).await?;

    // Сбой чтения БД — НЕ «токен не задан»: раньше map_err(...).ok() глотал
    // ошибку хранилища и пользователь получал вводящую в заблуждение 400.
    let token = state
        .store
        .get_setting(SETTING_GITHUB_TOKEN)
        .await
        .map_err(internal)?
        .map(|t| t.trim().to_string())
        .filter(|t| !t.is_empty())
        .ok_or_else(|| ApiError::new(
            StatusCode::BAD_REQUEST,
            "GitHub токен не задан в настройках",
        ))?;

    let mut channels = Vec::with_capacity(UPDATE_CHANNELS.len());
    for channel in UPDATE_CHANNELS {
        let dto = read_alias_channel(&state, &token, channel)
            .await
            .map_err(internal)?;
        channels.push(dto);
    }
    Ok(Json(channels))
}

/// `GET /api/releases/build-runs` — прогоняющиеся сейчас (или последние
/// упавшие) сборки релизов лаунчера из GitHub Actions. Показывает теги,
/// которые ещё не стали релизами: пока matrix собирается, релиза нет.
async fn build_runs(
    State(state): State<Shared>,
    headers: HeaderMap,
) -> Result<Json<Vec<BuildRunDto>>, ApiError> {
    require_admin(&state, &headers).await?;

    // Actions API требует авторизации даже для публичных репозиториев
    // в некоторых режимах — берём токен, но без него не падаем: экран
    // прогресса не критичен.
    let token = state
        .store
        .get_setting(SETTING_GITHUB_TOKEN)
        .await
        .ok()
        .flatten()
        .map(|t| t.trim().to_string())
        .filter(|t| !t.is_empty());

    let runs_url = format!(
        "https://api.github.com/repos/{GITHUB_REPO}/actions/runs?per_page=20"
    );
    let resp = match &token {
        Some(token) => {
            github_api(
                &state,
                reqwest::Method::GET,
                &runs_url,
                token,
                GH_ACCEPT_ACTIONS,
                None,
            )
            .await
            .map_err(internal)?
        }
        None => state
            .http
            .get(&runs_url)
            .header("Accept", GH_ACCEPT_ACTIONS)
            .send()
            .await
            .map_err(|e| internal(format!("запрос прогонов сборки: {e}")))?,
    };
    if !resp.status().is_success() {
        return Err(internal(format!(
            "прогоны сборки: HTTP {} (проверьте GitHub токен)",
            resp.status().as_u16()
        )));
    }

    #[derive(Deserialize)]
    struct WorkflowRun {
        id: i64,
        name: Option<String>,
        head_branch: Option<String>,
        event: String,
        status: String,
        conclusion: Option<String>,
        created_at: Option<String>,
    }
    #[derive(Deserialize)]
    struct RunsResponse {
        workflow_runs: Vec<WorkflowRun>,
    }
    let runs: RunsResponse = resp
        .json()
        .await
        .map_err(|e| internal(format!("парсинг прогонов сборки: {e}")))?;

    // Нас интересуют теговые прогоны launcher-release. Берём все недавние,
    // фильтр «живых» и упавших сделает фронтенд вместе с релизами.
    let tag_runs: Vec<WorkflowRun> = runs
        .workflow_runs
        .into_iter()
        .filter(|r| {
            r.name.as_deref() == Some(LAUNCHER_WORKFLOW_NAME)
                && r.event == "push"
                && r.head_branch
                    .as_deref()
                    .is_some_and(|b| b.starts_with('v'))
        })
        .take(10)
        .collect();

    // Для каждого прогона — состояние jobs-легов матрицы. Ноги нужны и
    // завершённым: упавшая сборка без ног не говорит, какая платформа
    // сломалась.
    let mut result: Vec<BuildRunDto> = Vec::new();
    for run in tag_runs {
        let legs = match fetch_run_jobs(&state, token.as_deref(), run.id).await {
            Ok(legs) => legs,
            Err(e) => {
                // Ошибка jobs не должна ронять весь список.
                tracing::warn!("build-runs: jobs прогона {}: {e}", run.id);
                Vec::new()
            }
        };
        result.push(BuildRunDto {
            tag: run.head_branch.unwrap_or_default(),
            state: gh_actions_state(&run.status, run.conclusion.as_deref()),
            run_id: run.id,
            started_at: run.created_at,
            legs,
        });
    }

    Ok(Json(result))
}

/// Jobs одного прогона launcher-release — леги матрицы windows/linux/macos.
async fn fetch_run_jobs(
    state: &Shared,
    token: Option<&str>,
    run_id: i64,
) -> Result<Vec<BuildLegDto>, String> {
    let jobs_url =
        format!("https://api.github.com/repos/{GITHUB_REPO}/actions/runs/{run_id}/jobs?per_page=20");
    let resp = match token {
        Some(token) => {
            github_api(
                state,
                reqwest::Method::GET,
                &jobs_url,
                token,
                GH_ACCEPT_ACTIONS,
                None,
            )
            .await?
        }
        None => state
            .http
            .get(&jobs_url)
            .header("Accept", GH_ACCEPT_ACTIONS)
            .send()
            .await
            .map_err(|e| format!("запрос jobs: {e}"))?,
    };
    if !resp.status().is_success() {
        return Err(format!("jobs: HTTP {}", resp.status().as_u16()));
    }

    #[derive(Deserialize)]
    struct Job {
        name: String,
        status: String,
        conclusion: Option<String>,
    }
    #[derive(Deserialize)]
    struct JobsResponse {
        jobs: Vec<Job>,
    }
    let jobs: JobsResponse = resp
        .json()
        .await
        .map_err(|e| format!("парсинг jobs: {e}"))?;

    // Имя job = «release (windows)» / «release (linux)» / «release (macos)».
    Ok(jobs
        .jobs
        .into_iter()
        .filter_map(|job| {
            let platform = job
                .name
                .rsplit('(')
                .next()?
                .trim_end_matches(')')
                .to_string();
            // Job release матрицы; publish-updater-alias сюда не попадает
            // (он в прогонах только после needs: release и с другим именем).
            if !["windows", "linux", "macos"].contains(&platform.as_str()) {
                return None;
            }
            Some(BuildLegDto {
                platform,
                state: gh_actions_state(&job.status, job.conclusion.as_deref()),
            })
        })
        .collect())
}

/// `GET /api/releases` — релизы лаунчера (тег `v*`) из GitHub API,
/// от новых к старым, максимум 10. Требует авторизации админа: список
/// ходит в GitHub с токеном из настроек, когда он задан.
async fn list_releases(
    State(state): State<Shared>,
    headers: HeaderMap,
) -> Result<Json<Vec<ReleaseDto>>, ApiError> {
    require_admin(&state, &headers).await?;

    let url = format!("https://api.github.com/repos/{GITHUB_REPO}/releases?per_page=30");
    let resp = state
        .http
        .get(&url)
        .header("Accept", "application/vnd.github.v3+json")
        .send()
        .await
        .map_err(|e| internal(format!("запрос списка релизов: {e}")))?;

    let releases: Vec<GitHubRelease> = resp
        .json()
        .await
        .map_err(|e| internal(format!("парсинг списка релизов: {e}")))?;

    let mut launcher_releases: Vec<GitHubRelease> = releases
        .into_iter()
        .filter(|r| r.tag_name.starts_with('v'))
        .collect();
    // published_at DESC (пустые — в конец), затем берём 10.
    launcher_releases.sort_by(|a, b| {
        let key = |r: &GitHubRelease| r.published_at.clone().unwrap_or_default();
        key(b).cmp(&key(a))
    });
    launcher_releases.truncate(10);

    Ok(Json(
        launcher_releases
            .into_iter()
            .map(|r| ReleaseDto {
                tag: r.tag_name,
                name: r.name,
                prerelease: r.prerelease,
                published_at: r.published_at,
            })
            .collect(),
    ))
}

/// `GET /api/releases/promote-status` — статус продвижения.
async fn promote_status(
    State(state): State<Shared>,
    headers: HeaderMap,
) -> Result<Json<PromoteStatus>, ApiError> {
    require_admin(&state, &headers).await?;
    Ok(Json(state.promote_status.lock().await.clone()))
}

/// `POST /api/releases/:tag/promote` — выкатить pre-release релиз лаунчера
/// в stable: снять метку pre-release и обновить latest.json в алиасе
/// launcher-stable. Фоновая задача со статусом.
async fn promote_release(
    State(state): State<Shared>,
    headers: HeaderMap,
    Path(tag): Path<String>,
) -> Result<(StatusCode, Json<serde_json::Value>), ApiError> {
    require_admin(&state, &headers).await?;

    // Тег обязан быть строгим vX.Y.Z: он попадает в path URL GitHub с токеном.
    if !tag_is_release(&tag) {
        return Err(ApiError::new(
            StatusCode::NOT_FOUND,
            format!("Тег {tag} не является релизом лаунчера"),
        ));
    }

    {
        let mut running = state.release_task_running.lock().await;
        if *running {
            return Err(ApiError::new(
                StatusCode::CONFLICT,
                "Канальная задача уже выполняется (перевод в стабильный или перестановка latest)",
            ));
        }
        *running = true;
    }

    {
        let mut status = state.promote_status.lock().await;
        *status = PromoteStatus {
            state: SyncState::Running,
            tag: Some(tag.clone()),
            phase: "Проверка релиза".to_string(),
            started_at: Some(
                OffsetDateTime::now_utc()
                    .format(&Rfc3339)
                    .unwrap_or_default(),
            ),
            ..Default::default()
        };
    }

    let task_state = Arc::clone(&state);
    let task_tag = tag;
    tokio::spawn(async move {
        // Паника внутри задачи не должна навсегда оставить guard
        // «задача выполняется» — снимаем его при любом выходе.
        struct ReleaseGuard(Shared);
        impl Drop for ReleaseGuard {
            fn drop(&mut self) {
                tokio::spawn({
                    let state = Arc::clone(&self.0);
                    async move {
                        *state.release_task_running.lock().await = false;
                    }
                });
            }
        }
        let _guard = ReleaseGuard(task_state.clone());
        let result = do_promote_release(&task_state, &task_tag).await;
        let mut status = task_state.promote_status.lock().await;
        match result {
            Ok(()) => {
                status.state = SyncState::Success;
                status.phase = "Готово: релиз в stable".to_string();
                status.error = None;
            }
            Err(message) => {
                status.state = SyncState::Error;
                status.phase = "Ошибка".to_string();
                status.error = Some(message.clone());
                tracing::warn!("promote-release: {message}");
            }
        }
        status.finished_at = Some(
            OffsetDateTime::now_utc()
                .format(&Rfc3339)
                .unwrap_or_default(),
        );
        // Guard снят при выходе из scope (Drop выше). Повторное снятие здесь
        // гонит с Drop'ом и может снять guard уже СЛЕДУЮЩЕЙ канальной задачи,
        // запущенной между Drop и этой строкой — защита слетала бы на ровном месте.
    });

    Ok((
        StatusCode::ACCEPTED,
        Json(serde_json::json!({ "inProgress": true })),
    ))
}

async fn update_promote_status(state: &Shared, update: impl FnOnce(&mut PromoteStatus)) {
    let mut status = state.promote_status.lock().await;
    update(&mut status);
}

/// `GET /api/releases/set-latest-status` — статус перестановки latest.
async fn set_latest_status(
    State(state): State<Shared>,
    headers: HeaderMap,
) -> Result<Json<SetLatestStatus>, ApiError> {
    require_admin(&state, &headers).await?;
    Ok(Json(state.set_latest_status.lock().await.clone()))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SetLatestRequest {
    /// `beta` | `stable`.
    channel: String,
}

/// `POST /api/releases/:tag/set-latest` — направить канал апдейтера
/// (beta/stable) на релиз с этим тегом: latest.json релиза копируется
/// в алиас канала. Откат и переключение без снятия pre-release метки.
/// Фоновая задача со статусом.
async fn set_latest(
    State(state): State<Shared>,
    headers: HeaderMap,
    Path(tag): Path<String>,
    Json(req): Json<SetLatestRequest>,
) -> Result<(StatusCode, Json<serde_json::Value>), ApiError> {
    require_admin(&state, &headers).await?;

    // Тег обязан быть строгим vX.Y.Z: он попадает в path URL GitHub с токеном.
    if !tag_is_release(&tag) {
        return Err(ApiError::new(
            StatusCode::NOT_FOUND,
            format!("Тег {tag} не является релизом лаунчера"),
        ));
    }
    if !UPDATE_CHANNELS.contains(&req.channel.as_str()) {
        return Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            format!("Неизвестный канал {} (ожидаются beta или stable)", req.channel),
        ));
    }

    {
        let mut running = state.release_task_running.lock().await;
        if *running {
            return Err(ApiError::new(
                StatusCode::CONFLICT,
                "Канальная задача уже выполняется (перевод в стабильный или перестановка latest)",
            ));
        }
        *running = true;
    }

    {
        let mut status = state.set_latest_status.lock().await;
        *status = SetLatestStatus {
            state: SyncState::Running,
            channel: Some(req.channel.clone()),
            tag: Some(tag.clone()),
            phase: "Проверка релиза".to_string(),
            started_at: Some(
                OffsetDateTime::now_utc()
                    .format(&Rfc3339)
                    .unwrap_or_default(),
            ),
            ..Default::default()
        };
    }

    let task_state = Arc::clone(&state);
    let task_tag = tag;
    let task_channel = req.channel;
    tokio::spawn(async move {
        // Паника внутри задачи не должна навсегда оставить guard
        // «задача выполняется» — снимаем его при любом выходе.
        struct ReleaseGuard(Shared);
        impl Drop for ReleaseGuard {
            fn drop(&mut self) {
                tokio::spawn({
                    let state = Arc::clone(&self.0);
                    async move {
                        *state.release_task_running.lock().await = false;
                    }
                });
            }
        }
        let _guard = ReleaseGuard(task_state.clone());
        let result = do_set_latest(&task_state, &task_channel, &task_tag).await;
        let mut status = task_state.set_latest_status.lock().await;
        match result {
            Ok(()) => {
                status.state = SyncState::Success;
                status.phase = format!("Готово: канал {} на {}", task_channel, task_tag);
                status.error = None;
            }
            Err(message) => {
                status.state = SyncState::Error;
                status.phase = "Ошибка".to_string();
                status.error = Some(message.clone());
                tracing::warn!("set-latest: {message}");
            }
        }
        status.finished_at = Some(
            OffsetDateTime::now_utc()
                .format(&Rfc3339)
                .unwrap_or_default(),
        );
        // Guard снят при выходе из scope (Drop выше); повторное снятие здесь
        // могло снять guard следующей канальной задачи (гонка с Drop'ом).
    });

    Ok((
        StatusCode::ACCEPTED,
        Json(serde_json::json!({ "inProgress": true })),
    ))
}

async fn update_set_latest_status(state: &Shared, update: impl FnOnce(&mut SetLatestStatus)) {
    let mut status = state.set_latest_status.lock().await;
    update(&mut status);
}

/// Перестановка latest канала: скачать latest.json из релиза тега,
/// провалидировать платформы и опубликовать в алиас канала.
async fn do_set_latest(state: &Shared, channel: &str, tag: &str) -> Result<(), String> {
    update_set_latest_status(state, |s| s.phase = "Проверка релиза".to_string()).await;

    // 1. Токен из настроек.
    let token = state
        .store
        .get_setting(SETTING_GITHUB_TOKEN)
        .await
        .map_err(|e| e.to_string())?
        .map(|t| t.trim().to_string())
        .filter(|t| !t.is_empty())
        .ok_or_else(|| "GitHub токен не задан в настройках".to_string())?;

    // 2. Релиз по тегу.
    let release_url = format!("https://api.github.com/repos/{GITHUB_REPO}/releases/tags/{tag}");
    let resp = github_api(state, reqwest::Method::GET, &release_url, &token, GH_ACCEPT_V3, None).await?;
    if resp.status() == reqwest::StatusCode::NOT_FOUND {
        return Err(format!("Релиз {tag} не найден на GitHub"));
    }
    if !resp.status().is_success() {
        return Err(format!(
            "получение релиза {tag}: HTTP {} (проверьте GitHub токен)",
            resp.status().as_u16()
        ));
    }
    let release: GitHubRelease = resp
        .json()
        .await
        .map_err(|e| format!("парсинг релиза {tag}: {e}"))?;

    // Stable-канал раздаёт только полноценные релизы: pre-release нужно
    // сначала перевести в стабильный (фронтенд блокирует пилюлю, здесь —
    // вторая линия обороны для прямых POST).
    if channel == "stable" && release.prerelease {
        return Err(format!(
            "Релиз {tag} — pre-release: сначала переведите его в стабильный"
        ));
    }

    // 3. latest.json из ассетов релиза.
    update_set_latest_status(state, |s| s.phase = "Валидация latest.json".to_string()).await;
    let latest_asset = release
        .assets
        .iter()
        .find(|a| a.name == "latest.json")
        .ok_or_else(|| {
            format!("В релизе {tag} нет ассета latest.json — релиз неполный")
        })?;

    let latest_bytes =
        fetch_release_asset(state, &latest_asset.browser_download_url, "latest.json").await?;

    // Валидация: платформы содержат все три семейства (как в CI alias job).
    let latest: serde_json::Value = serde_json::from_slice(&latest_bytes)
        .map_err(|e| format!("latest.json не парсится: {e}"))?;
    let platforms = latest
        .get("platforms")
        .and_then(|p| p.as_object())
        .ok_or_else(|| "latest.json не содержит объект platforms".to_string())?;
    let families: std::collections::HashSet<&str> = platforms
        .keys()
        .map(|key| key.split('-').next().unwrap_or(""))
        .collect();
    for required in ["darwin", "linux", "windows"] {
        if !families.contains(required) {
            return Err(format!(
                "latest.json неполный: нет семейства {required} (есть: {:?})",
                families.iter().collect::<Vec<_>>()
            ));
        }
    }

    // 4. Публикация в алиас канала.
    update_set_latest_status(state, |s| {
        s.phase = format!("Публикация в канал {channel}")
    })
    .await;
    publish_latest_to_alias(state, &token, channel, latest_bytes).await?;

    tracing::info!("set-latest: канал {channel} направлен на {tag}");
    Ok(())
}

/// Прогон GitHub-запроса с токеном. Токен уходит ТОЛЬКО на api.github.com /
/// uploads.github.com (в URL-хосте проверяем), чтобы не утечь в чужой хост
/// при редиректе или ошибке в URL.
/// Прогон GitHub-запроса с токеном. Токен уходит ТОЛЬКО на api.github.com /
/// uploads.github.com (в URL-хосте проверяем), чтобы не утечь в чужой хост
/// при редиректе или ошибке в URL. `accept` — вариант media type
/// (releases: v3+json, actions: vnd.github+json).
async fn github_api(
    state: &Shared,
    method: reqwest::Method,
    url: &str,
    token: &str,
    accept: &str,
    body: Option<serde_json::Value>,
) -> Result<reqwest::Response, String> {
    if !is_github_host(url) {
        return Err("внутренняя ошибка: запрос не на GitHub API".to_string());
    }
    let mut request = state
        .http
        .request(method, url)
        .header("Accept", accept)
        .header("Authorization", format!("Bearer {token}"));
    if let Some(body) = body {
        request = request.json(&body);
    }
    request
        .send()
        .await
        .map_err(|e| format!("запрос к GitHub API: {e}"))
}

/// Media type для REST API GitHub (releases и пр.).
const GH_ACCEPT_V3: &str = "application/vnd.github.v3+json";
/// Media type для Actions API GitHub.
const GH_ACCEPT_ACTIONS: &str = "application/vnd.github+json";

/// Проверяет, что URL ведёт на api.github.com или uploads.github.com.
fn is_github_host(url: &str) -> bool {
    reqwest::Url::parse(url)
        .ok()
        .and_then(|u| u.host_str().map(|h| h.to_string()))
        .is_some_and(|h| h == "api.github.com" || h == "uploads.github.com")
}

/// Скачивает ассет релиза GitHub с проверкой HTTP-статуса: на сбой GitHub
/// отвечает телом ошибки (HTML/JSON), которое без проверки попадало бы
/// в парсер и дальше — например, «не парсится» вместо реальной причины.
async fn fetch_release_asset(
    state: &Shared,
    url: &str,
    what: &str,
) -> Result<Vec<u8>, String> {
    let resp = state
        .http
        .get(url)
        .send()
        .await
        .map_err(|e| format!("скачивание {what}: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!(
            "{what}: GitHub вернул HTTP {}",
            resp.status().as_u16()
        ));
    }
    resp.bytes()
        .await
        .map(|b| b.to_vec())
        .map_err(|e| format!("чтение {what}: {e}"))
}

/// Продвижение релиза лаунчера в stable. Шаги:
/// 1) проверка релиза по тегу;
/// 2) скачивание и валидация latest.json (все три семейства:
///    darwin/linux/windows);
/// 3) снятие pre-release метки;
/// 4) публикация latest.json в алиас launcher-stable.
async fn do_promote_release(state: &Shared, tag: &str) -> Result<(), String> {
    update_promote_status(state, |s| s.phase = "Проверка релиза".to_string()).await;

    // 1. Токен из настроек.
    let token = state
        .store
        .get_setting(SETTING_GITHUB_TOKEN)
        .await
        .map_err(|e| e.to_string())?
        .map(|t| t.trim().to_string())
        .filter(|t| !t.is_empty())
        .ok_or_else(|| "GitHub токен не задан в настройках".to_string())?;

    // 2. Релиз по тегу.
    let release_url = format!("https://api.github.com/repos/{GITHUB_REPO}/releases/tags/{tag}");
    let resp = github_api(state, reqwest::Method::GET, &release_url, &token, GH_ACCEPT_V3, None)
        .await?;
    if resp.status() == reqwest::StatusCode::NOT_FOUND {
        return Err(format!("Релиз {tag} не найден на GitHub"));
    }
    if !resp.status().is_success() {
        // Частые случаи: 401/403 — токен неверный или без прав repo.
        return Err(format!(
            "получение релиза {tag}: HTTP {} (проверьте GitHub токен)",
            resp.status().as_u16()
        ));
    }
    let release: GitHubRelease = resp
        .json()
        .await
        .map_err(|e| format!("парсинг релиза {tag}: {e}"))?;

    // 3. latest.json из ассетов релиза.
    update_promote_status(state, |s| s.phase = "Валидация latest.json".to_string()).await;
    let latest_asset = release
        .assets
        .iter()
        .find(|a| a.name == "latest.json")
        .ok_or_else(|| {
            format!("В релизе {tag} нет ассета latest.json — релиз неполный")
        })?;

    let latest_bytes =
        fetch_release_asset(state, &latest_asset.browser_download_url, "latest.json").await?;

    // Валидация: платформы содержат все три семейства. Семейство — первый
    // токен ключа платформы, разделённый дефисами (как в CI alias job).
    let latest: serde_json::Value =
        serde_json::from_slice(&latest_bytes).map_err(|e| format!("latest.json не парсится: {e}"))?;
    let platforms = latest
        .get("platforms")
        .and_then(|p| p.as_object())
        .ok_or_else(|| "latest.json не содержит объект platforms".to_string())?;
    let families: std::collections::HashSet<&str> = platforms
        .keys()
        .map(|key| key.split('-').next().unwrap_or(""))
        .collect();
    for required in ["darwin", "linux", "windows"] {
        if !families.contains(required) {
            return Err(format!(
                "latest.json неполный: нет семейства {required} (есть: {:?})",
                families.iter().collect::<Vec<_>>()
            ));
        }
    }

    // 4. Снятие pre-release метки.
    update_promote_status(state, |s| {
        s.phase = "Снятие pre-release метки".to_string()
    })
    .await;
    let release_id = release.id.ok_or_else(|| {
        format!("GitHub не вернул id релиза {tag} — невозможно обновить")
    })?;
    let patch_url = format!("https://api.github.com/repos/{GITHUB_REPO}/releases/{release_id}");
    let resp = github_api(
        state,
        reqwest::Method::PATCH,
        &patch_url,
        &token,
        GH_ACCEPT_V3,
        Some(serde_json::json!({ "prerelease": false })),
    )
    .await?;
    if !resp.status().is_success() {
        return Err(format!(
            "снятие pre-release метки с {tag}: HTTP {}",
            resp.status().as_u16()
        ));
    }

    // 5. Публикация latest.json в алиас launcher-stable.
    update_promote_status(state, |s| {
        s.phase = "Публикация в launcher-stable".to_string()
    })
    .await;
    publish_latest_to_alias(state, &token, "stable", latest_bytes).await?;

    tracing::info!("promote-release: {tag} продвинут в stable ({STABLE_ALIAS_TAG})");
    Ok(())
}

/// Публикация latest.json в алиас-канал апдейтера (launcher-beta /
/// launcher-stable): найти алиас или создать, удалить старый latest.json
/// (upload не перезаписывает) и загрузить новый. Общая для продвижения
/// в stable и для перестановки latest канала.
async fn publish_latest_to_alias(
    state: &Shared,
    token: &str,
    channel: &str,
    latest_bytes: Vec<u8>,
) -> Result<(), String> {
    let (alias_tag, alias_title) = match channel {
        "beta" => (BETA_ALIAS_TAG, "StarDust Launcher (beta updater)"),
        "stable" => (STABLE_ALIAS_TAG, "StarDust Launcher (stable updater)"),
        _ => return Err(format!("неизвестный канал {channel}")),
    };

    // 1. Алиас: найти или создать.
    let alias_url =
        format!("https://api.github.com/repos/{GITHUB_REPO}/releases/tags/{alias_tag}");
    let resp = github_api(state, reqwest::Method::GET, &alias_url, token, GH_ACCEPT_V3, None).await?;
    let alias_release: GitHubRelease = if resp.status() == reqwest::StatusCode::NOT_FOUND {
        // Создаём алиас (gh-style), ошибки статуса проверим ниже.
        let create_url = format!("https://api.github.com/repos/{GITHUB_REPO}/releases");
        let resp = github_api(
            state,
            reqwest::Method::POST,
            &create_url,
            token,
            GH_ACCEPT_V3,
            Some(serde_json::json!({
                "tag_name": alias_tag,
                "name": alias_title,
                "notes": "Updater metadata alias for launcher releases."
            })),
        )
        .await?;
        if !resp.status().is_success() {
            return Err(format!(
                "создание алиаса {alias_tag}: HTTP {}",
                resp.status().as_u16()
            ));
        }
        resp.json()
            .await
            .map_err(|e| format!("парсинг созданного алиаса: {e}"))?
    } else if !resp.status().is_success() {
        // Не 404 и не успех — обычно неверный токен (401/403).
        return Err(format!(
            "получение алиаса {alias_tag}: HTTP {} (проверьте GitHub токен)",
            resp.status().as_u16()
        ));
    } else {
        resp.json()
            .await
            .map_err(|e| format!("парсинг алиаса {alias_tag}: {e}"))?
    };
    let alias_id = alias_release
        .id
        .ok_or_else(|| format!("GitHub не вернул id алиаса {alias_tag}"))?;

    // 2. Удаляем старый latest.json с алиаса, если он есть
    //    (upload не перезаписывает).
    if let Some(old_asset) = alias_release.assets.iter().find(|a| a.name == "latest.json") {
        if let Some(asset_id) = old_asset.id {
            let delete_url =
                format!("https://api.github.com/repos/{GITHUB_REPO}/releases/assets/{asset_id}");
            let resp = github_api(state, reqwest::Method::DELETE, &delete_url, token, GH_ACCEPT_V3, None).await?;
            // 404 = уже удалён кем-то другим, это не ошибка.
            if !resp.status().is_success() && resp.status() != reqwest::StatusCode::NOT_FOUND {
                return Err(format!(
                    "удаление старого latest.json: HTTP {}",
                    resp.status().as_u16()
                ));
            }
        }
    }

    // 3. Загружаем новый latest.json. Прямой POST на uploads.github.com
    // (github_api не берёт байты-тело): хост проверяем тем же guard'ом.
    let upload_url = format!(
        "https://uploads.github.com/repos/{GITHUB_REPO}/releases/{alias_id}/assets?name=latest.json"
    );
    if !is_github_host(&upload_url) {
        return Err("внутренняя ошибка: загрузка не на GitHub".to_string());
    }
    let resp = state
        .http
        .post(&upload_url)
        .header("Accept", GH_ACCEPT_V3)
        .header("Authorization", format!("Bearer {token}"))
        .header("Content-Type", "application/octet-stream")
        .body(latest_bytes)
        .send()
        .await
        .map_err(|e| format!("загрузка latest.json в {alias_tag}: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!(
            "загрузка latest.json в {alias_tag}: HTTP {}",
            resp.status().as_u16()
        ));
    }

    Ok(())
}

// ───────────────── Публичные сезоны ─────────────────

/// Публичная карточка сезона (архивированные только).
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PublicSeasonDto {
    id: i32,
    name: String,
    ended_at: Option<String>,
}

/// `GET /public/seasons` — список архивированных сезонов.
async fn public_seasons(
    State(state): State<Shared>,
) -> Result<Json<Vec<PublicSeasonDto>>, ApiError> {
    let seasons = state.store.archived_seasons().await.map_err(map_store)?;
    Ok(Json(
        seasons
            .into_iter()
            .map(|s| PublicSeasonDto {
                id: s.id,
                name: s.name,
                ended_at: s.ended_at,
            })
            .collect(),
    ))
}

/// `GET /public/seasons/:id/leaderboards` — топы снимка сезона.
async fn public_season_leaderboards(
    State(state): State<Shared>,
    Path(id): Path<i32>,
) -> Result<Json<protocol::Leaderboards>, ApiError> {
    let season = state
        .store
        .archived_season(id)
        .await
        .map_err(map_store)?
        .ok_or_else(|| ApiError::new(StatusCode::NOT_FOUND, "Сезон не найден"))?;

    let boards = state
        .store
        .season_leaderboards(season.id)
        .await
        .map_err(map_store)?;
    let to_entries = |rows: Vec<(i64, String, i64)>| {
        rows.into_iter()
            .map(|(rank, username, value)| protocol::LeaderboardEntry {
                rank,
                username,
                value,
            })
            .collect()
    };
    Ok(Json(protocol::Leaderboards {
        playtime: to_entries(boards.playtime),
        deaths: to_entries(boards.deaths),
        blocks_mined: to_entries(boards.blocks_mined),
        distance: to_entries(boards.distance),
    }))
}

// ───────────────────────── Деплой мода ─────────────────────────

#[derive(Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct DeployModStatus {
    state: SyncState,
    phase: String,
    version: Option<String>,
    error: Option<String>,
    started_at: Option<String>,
    finished_at: Option<String>,
}

#[derive(Deserialize)]
struct GitHubRelease {
    id: Option<i64>,
    tag_name: String,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    prerelease: bool,
    /// ISO-строка от GitHub (published_at уже в RFC 3339).
    #[serde(default)]
    published_at: Option<String>,
    #[serde(default)]
    assets: Vec<GitHubAsset>,
}

/// Выбор jar мода из ассетов релиза под нужный загрузчик.
///
/// Релизы mod-v* с 0.5.0 несут два jar: `stardust-mod-<ver>.jar` (NeoForge)
/// и `stardust-mod-fabric-<ver>.jar` (Fabric). Отличаем их по сегменту
/// после последнего дефиса в stem (`-fabric`), а не по подстроке «fabric»
/// где угодно — иначе имя версии вроде `0.5.0-fabric` в NeoForge-jar
/// совпало бы. `sources.jar` и не-jar ассеты отбрасываются.
fn find_mod_jar(assets: &[GitHubAsset], want_fabric: bool) -> Option<&GitHubAsset> {
    assets
        .iter()
        .filter(|a| a.name.ends_with(".jar") && !a.name.ends_with("-sources.jar"))
        .find(|a| asset_jar_is_fabric(&a.name) == want_fabric)
}

/// True, если имя jar — Fabric-версия мода (`stardust-mod-fabric-0.5.0.jar`).
///
/// Имена ассетов предсказуемы: `stardust-mod-<ver>.jar` (NeoForge) и
/// `stardust-mod-fabric-<ver>.jar` (Fabric) — третий сегмент stem равен
/// `fabric` ровно у Fabric-версии.
fn asset_jar_is_fabric(name: &str) -> bool {
    name.strip_suffix(".jar")
        .unwrap_or(name)
        .split('-')
        .nth(2)
        .is_some_and(|segment| segment == "fabric")
}

#[derive(Deserialize)]
struct GitHubAsset {
    id: Option<i64>,
    name: String,
    browser_download_url: String,
    /// RFC 3339 публикации ассета (для «обновлён …» в каналах).
    #[serde(default)]
    updated_at: Option<String>,
}

async fn deploy_mod(
    State(state): State<Shared>,
    headers: HeaderMap,
) -> Result<(StatusCode, Json<serde_json::Value>), ApiError> {
    require_admin(&state, &headers).await?;

    {
        let mut running = state.deploy_mod_running.lock().await;
        if *running {
            return Err(ApiError::new(
                StatusCode::CONFLICT,
                "Деплой мода уже выполняется",
            ));
        }
        *running = true;
    }

    update_deploy_mod_status(&state, |status| {
        *status = DeployModStatus {
            state: SyncState::Running,
            phase: "Подготовка".to_string(),
            started_at: Some(
                OffsetDateTime::now_utc()
                    .format(&Rfc3339)
                    .unwrap_or_default(),
            ),
            ..Default::default()
        };
    })
    .await;

    let task_state = Arc::clone(&state);
    tokio::spawn(async move {
        match do_deploy_mod(Arc::clone(&task_state)).await {
            Ok(version) => {
                update_deploy_mod_status(&task_state, |status| {
                    status.state = SyncState::Success;
                    status.phase = "Готово".to_string();
                    status.version = Some(version);
                    status.finished_at = Some(
                        OffsetDateTime::now_utc()
                            .format(&Rfc3339)
                            .unwrap_or_default(),
                    );
                })
                .await;
            }
            Err(e) => {
                let msg = e.message.clone();
                tracing::warn!("deploy-mod: ошибка: {}", msg);
                update_deploy_mod_status(&task_state, |status| {
                    status.state = SyncState::Error;
                    status.phase = "Ошибка".to_string();
                    status.error = Some(msg);
                    status.finished_at = Some(
                        OffsetDateTime::now_utc()
                            .format(&Rfc3339)
                            .unwrap_or_default(),
                    );
                })
                .await;
            }
        }
        *task_state.deploy_mod_running.lock().await = false;
    });

    Ok((
        StatusCode::ACCEPTED,
        Json(serde_json::json!({ "inProgress": true })),
    ))
}

async fn deploy_mod_status(
    State(state): State<Shared>,
    headers: HeaderMap,
) -> Result<Json<DeployModStatus>, ApiError> {
    require_admin(&state, &headers).await?;
    let status = state.deploy_mod_status.lock().await.clone();
    Ok(Json(status))
}

async fn update_deploy_mod_status(state: &Shared, update: impl FnOnce(&mut DeployModStatus)) {
    let mut status = state.deploy_mod_status.lock().await;
    update(&mut status);
}

async fn do_deploy_mod(state: Shared) -> Result<String, ApiError> {
    // 1. Получаем последний релиз мода из GitHub API.
    update_deploy_mod_status(&state, |s| s.phase = "Запрос к GitHub API".to_string()).await;

    let release: GitHubRelease = {
        let releases_url = "https://api.github.com/repos/Zeragorn-ru/stardust/releases?per_page=10";
        let resp = state
            .http
            .get(releases_url)
            .header("Accept", "application/vnd.github.v3+json")
            .send()
            .await
            .map_err(|e| internal(format!("запрос списка релизов: {e}")))?;

        let releases: Vec<GitHubRelease> = resp
            .json()
            .await
            .map_err(|e| internal(format!("парсинг списка релизов: {e}")))?;

        let mut mod_releases: Vec<GitHubRelease> = releases
            .into_iter()
            .filter(|r| r.tag_name.starts_with("mod-v"))
            .collect();
        mod_releases.sort_by(|a, b| {
            // Нечисловые сегменты тега обрабатываем явно: «1.2.3a» → ниже
            // любой числовой версии (0 в паре с флагом), а не отбрасываем
            // молча — filter_map превращал «v3» и «v3.10» в одинаковые
            // векторы и порядок «последнего релиза» становился произвольным.
            let parse = |r: &GitHubRelease| -> Vec<(u32, bool)> {
                r.tag_name
                    .strip_prefix("mod-v")
                    .unwrap_or(&r.tag_name)
                    .split('.')
                    .map(|s| match s.parse::<u32>() {
                        Ok(n) => (n, true),
                        Err(_) => (0, false),
                    })
                    .collect()
            };
            parse(b).cmp(&parse(a))
        });
        mod_releases.into_iter().next().ok_or_else(|| {
            ApiError::new(StatusCode::NOT_FOUND, "Релизы мода (mod-v*) не найдены")
        })?
    };

    let version = release
        .tag_name
        .strip_prefix("mod-v")
        .unwrap_or(&release.tag_name)
        .to_string();

    update_deploy_mod_status(&state, |s| {
        s.phase = format!("Релиз: {}", release.tag_name);
        s.version = Some(version.clone());
    })
    .await;

    // 2. Определяем активную сборку: её loader_kind диктует, какой jar качать
    // (в релизе mod-v* с 0.5.0 лежат ОБА: stardust-mod-*.jar (NeoForge) и
    // stardust-mod-fabric-*.jar (Fabric)).
    let build = state
        .store
        .active_build()
        .await
        .map_err(internal)?
        .ok_or_else(|| ApiError::new(StatusCode::NOT_FOUND, "Нет активной сборки"))?;

    let want_fabric = build.header.loader_kind.eq_ignore_ascii_case("fabric");

    let jar_asset =
        find_mod_jar(&release.assets, want_fabric).ok_or_else(|| {
            let expected = if want_fabric { "fabric-" } else { "NeoForge-" };
            ApiError::new(
                StatusCode::NOT_FOUND,
                format!(
                    "jar-файл ({expected}версия) не найден в релизе {}",
                    release.tag_name
                ),
            )
        })?;

    // Имя ассета из GitHub не должно содержать path-traversal (`..`, `/`, `\`).
    let jar_name = sanitize_asset_filename(&jar_asset.name)?;

    update_deploy_mod_status(&state, |s| {
        s.phase = format!("Скачивание {jar_name}");
    })
    .await;

    // Статус проверяет хелпер: на сбой GitHub отвечает телом ошибки, и без
    // проверки оно ложилось бы в хранилище и раздавалось сборке как «мод».
    let jar_bytes = fetch_release_asset(
        &state,
        &jar_asset.browser_download_url,
        &format!("jar {jar_name}"),
    )
    .await
    .map_err(internal)?;

    let size_bytes = jar_bytes.len() as i64;
    let sha1 = sha1_hex(&jar_bytes);

    tracing::info!("deploy-mod: скачан {jar_name} ({size_bytes} байт, sha1={sha1})",);

    // 3. Сохраняем jar в контент-адресное хранилище (modpack_dir/sha1).
    update_deploy_mod_status(&state, |s| {
        s.phase = "Сохранение в хранилище".to_string();
    })
    .await;

    let dest = state.modpack_dir.join(&sha1);
    if !dest.exists() {
        tokio::fs::write(&dest, &jar_bytes)
            .await
            .map_err(|e| internal(format!("запись jar в хранилище: {e}")))?;
    }

    // 4. Добавляем/обновляем файл в активной сборке (build получен в шаге 2).
    update_deploy_mod_status(&state, |s| {
        s.phase = "Добавление в сборку".to_string();
    })
    .await;

    // 4.1 Сохраняем настройки стороны и т.д. из старого мода и удаляем его из сборки.
    let mut old_side = "server".to_string();
    let mut old_overwrite = true;
    let mut old_optional = false;
    let mut old_enabled_by_default = true;
    let mut old_disabled = false;
    let mut old_files_to_delete = Vec::new();

    for f in &build.files {
        // Заменяем только файлы ЭТОГО мода: явный mod_id «stardust» или jar,
        // чьё имя соответствует нашему шаблону имени ассета мода
        // (stardust[-<version>].jar). Голая подстрока «stardust» в пути
        // цепляла и посторонние моды вроде stardust-something-else.jar.
        let matches_name = f
            .path
            .rsplit('/')
            .next()
            .map(|name| {
                let stem = name.strip_suffix(".jar").unwrap_or(name);
                stem == "stardust"
                    || (stem.starts_with("stardust-") && stem["stardust-".len()..].chars().all(|c| c.is_ascii_digit() || c == '.'))
            })
            .unwrap_or(false);
        let is_stardust_mod =
            f.mod_id.as_deref() == Some("stardust") || (f.path.starts_with("mods/") && matches_name);
        if is_stardust_mod {
            old_side = f.side.clone();
            old_overwrite = f.overwrite;
            old_optional = f.optional;
            old_enabled_by_default = f.enabled_by_default;
            old_disabled = f.disabled;
            old_files_to_delete.push(f.id);
        }
    }

    for file_id in old_files_to_delete {
        state
            .store
            .delete_build_file(file_id)
            .await
            .map_err(map_store)?;
    }

    let file_path = format!("mods/{jar_name}");

    let file_input = store::BuildFileInput {
        path: file_path.clone(),
        sha1: sha1.clone(),
        size_bytes,
        side: old_side,
        kind: "mod".to_string(),
        overwrite: old_overwrite,
        optional: old_optional,
        enabled_by_default: old_enabled_by_default,
        disabled: old_disabled,
        mod_id: Some("stardust".to_string()),
        display_name: Some("Stardust Mod".to_string()),
        description: Some(format!("Stardust server mod {version}")),
        storage_key: sha1.clone(),
        profile_keys: Vec::new(),
    };

    state
        .store
        .upsert_build_file(build.header.id, file_input)
        .await
        .map_err(map_store)?;

    tracing::info!(
        "deploy-mod: {jar_name} добавлен в сборку #{} (путь: {file_path})",
        build.header.id,
    );

    Ok(version)
}

// ───────────────────────── Аккаунты ─────────────────────────

#[derive(Serialize)]
struct AccountDto {
    uuid: String,
    username: String,
    #[serde(rename = "isAdmin")]
    is_admin: bool,
    banned: bool,
    #[serde(rename = "bannedUntil", skip_serializing_if = "Option::is_none")]
    banned_until: Option<String>,
    #[serde(rename = "banReason", skip_serializing_if = "Option::is_none")]
    ban_reason: Option<String>,
    /// Привязан ли Telegram (для значка в таблице).
    #[serde(rename = "telegramLinked")]
    telegram_linked: bool,
    /// Telegram chat_id, если привязан (виден только админу).
    #[serde(rename = "telegramChatId", skip_serializing_if = "Option::is_none")]
    telegram_chat_id: Option<String>,
}

impl From<store::Account> for AccountDto {
    fn from(a: store::Account) -> Self {
        let is_admin = a.is_admin();
        let telegram_chat_id = a.telegram_chat_id.clone();
        let telegram_linked = telegram_chat_id.is_some();
        let (banned, banned_until, ban_reason) = if a.is_banned() {
            match a.ban {
                Some(ban) => (
                    true,
                    ban.until
                        .map(|u| u.format(&Rfc3339).unwrap_or_else(|_| u.to_string())),
                    ban.reason,
                ),
                None => (false, None, None),
            }
        } else {
            (false, None, None)
        };
        AccountDto {
            uuid: a.uuid,
            username: a.username,
            is_admin,
            banned,
            banned_until,
            ban_reason,
            telegram_linked,
            telegram_chat_id,
        }
    }
}

async fn list_accounts(
    State(state): State<Shared>,
    headers: HeaderMap,
) -> Result<Json<Vec<AccountDto>>, ApiError> {
    require_admin(&state, &headers).await?;
    let accounts = state.store.all_accounts().await.map_err(internal)?;
    Ok(Json(accounts.into_iter().map(AccountDto::from).collect()))
}

#[derive(Deserialize)]
struct UpdateAccountRequest {
    /// Новый ник (опционально).
    username: Option<String>,
}

/// Редактирование аккаунта админом (пока — переименование).
async fn update_account(
    State(state): State<Shared>,
    headers: HeaderMap,
    Path(uuid): Path<String>,
    Json(req): Json<UpdateAccountRequest>,
) -> Result<Json<AccountDto>, ApiError> {
    require_admin(&state, &headers).await?;
    if let Some(username) = req
        .username
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        state
            .store
            .rename(&uuid, username)
            .await
            .map_err(map_store)?;
    }
    let account = state
        .store
        .find_by_uuid(&uuid)
        .await
        .ok_or_else(|| ApiError::new(StatusCode::NOT_FOUND, "Аккаунт не найден"))?;
    Ok(Json(AccountDto::from(account)))
}

/// Удаление аккаунта админом.
async fn delete_account_admin(
    State(state): State<Shared>,
    headers: HeaderMap,
    Path(uuid): Path<String>,
) -> Result<StatusCode, ApiError> {
    let admin = require_admin(&state, &headers).await?;
    if normalize_for_compare(&admin.uuid) == normalize_for_compare(&uuid) {
        return Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            "Нельзя удалить свой собственный аккаунт",
        ));
    }
    state.store.delete_account(&uuid).await.map_err(map_store)?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize)]
struct BanRequest {
    /// Длительность бана в секундах. `None`/0 — бан навсегда.
    #[serde(rename = "durationSecs")]
    duration_secs: Option<i64>,
    reason: Option<String>,
}

/// Блокировка аккаунта админом.
async fn ban_account(
    State(state): State<Shared>,
    headers: HeaderMap,
    Path(uuid): Path<String>,
    Json(req): Json<BanRequest>,
) -> Result<Json<AccountDto>, ApiError> {
    let admin = require_admin(&state, &headers).await?;
    if normalize_for_compare(&admin.uuid) == normalize_for_compare(&uuid) {
        return Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            "Нельзя забанить свой собственный аккаунт",
        ));
    }
    // Верхняя граница длительности бана — 10 лет: без неё `Duration::from_secs`
    // паникует на огромных значениях из запроса (например 2^63/1000), а
    // сложение с OffsetDateTime — ещё и переполняется. Запредельные значения
    // приравниваем к постоянному бану.
    const MAX_BAN_SECS: i64 = 10 * 365 * 24 * 60 * 60;
    let until = match req.duration_secs {
        Some(secs) if secs > 0 => {
            let capped = secs.min(MAX_BAN_SECS) as u64;
            Some(OffsetDateTime::now_utc() + Duration::from_secs(capped))
        }
        _ => None,
    };
    let reason = req
        .reason
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty());
    state
        .store
        .ban_account(&uuid, until, reason)
        .await
        .map_err(map_store)?;
    let account = state
        .store
        .find_by_uuid(&uuid)
        .await
        .ok_or_else(|| ApiError::new(StatusCode::NOT_FOUND, "Аккаунт не найден"))?;
    Ok(Json(AccountDto::from(account)))
}

/// Снятие блокировки админом.
async fn unban_account(
    State(state): State<Shared>,
    headers: HeaderMap,
    Path(uuid): Path<String>,
) -> Result<Json<AccountDto>, ApiError> {
    require_admin(&state, &headers).await?;
    state.store.unban_account(&uuid).await.map_err(map_store)?;
    let account = state
        .store
        .find_by_uuid(&uuid)
        .await
        .ok_or_else(|| ApiError::new(StatusCode::NOT_FOUND, "Аккаунт не найден"))?;
    Ok(Json(AccountDto::from(account)))
}

#[derive(Deserialize)]
struct SetRoleRequest {
    /// Целевая роль: `admin` или `user`.
    role: String,
}

/// Смена роли аккаунта админом (выдать/снять права администратора).
///
/// Закрывает функциональный пробел: до этого первого админа можно было выдать
/// только через `ADMIN_BOOTSTRAP`. Запрещает снимать права с самого себя,
/// чтобы админ случайно не заблокировал себе доступ в панель.
async fn set_account_role(
    State(state): State<Shared>,
    headers: HeaderMap,
    Path(uuid): Path<String>,
    Json(req): Json<SetRoleRequest>,
) -> Result<Json<AccountDto>, ApiError> {
    let admin = require_admin(&state, &headers).await?;
    let role = match req.role.trim().to_lowercase().as_str() {
        "admin" => Role::Admin,
        "user" => Role::User,
        other => {
            return Err(ApiError::new(
                StatusCode::BAD_REQUEST,
                format!("Неизвестная роль: {other}"),
            ))
        }
    };
    if role == Role::User && normalize_for_compare(&admin.uuid) == normalize_for_compare(&uuid) {
        return Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            "Нельзя снять права администратора с самого себя",
        ));
    }
    state.store.set_role(&uuid, role).await.map_err(map_store)?;
    let account = state
        .store
        .find_by_uuid(&uuid)
        .await
        .ok_or_else(|| ApiError::new(StatusCode::NOT_FOUND, "Аккаунт не найден"))?;
    Ok(Json(AccountDto::from(account)))
}

#[derive(Deserialize)]
struct SetPasswordRequest {
    password: String,
}

/// Сброс пароля аккаунта админом. Старый пароль не требуется; активные сессии
/// пользователя сбрасываются (старые токены протухают). Полезно, когда игрок
/// забыл пароль и не может восстановить его через Telegram.
async fn set_account_password(
    State(state): State<Shared>,
    headers: HeaderMap,
    Path(uuid): Path<String>,
    Json(req): Json<SetPasswordRequest>,
) -> Result<StatusCode, ApiError> {
    require_admin(&state, &headers).await?;
    let password = req.password;
    if password.len() < 6 {
        return Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            "Пароль должен быть не короче 6 символов",
        ));
    }
    state
        .store
        .set_password(&uuid, &password)
        .await
        .map_err(map_store)?;
    Ok(StatusCode::NO_CONTENT)
}

/// Отвязывает Telegram от аккаунта (админ). Снимает 2FA/passwordless для
/// пользователя — например, если он потерял доступ к своему Telegram.
async fn unlink_account_telegram(
    State(state): State<Shared>,
    headers: HeaderMap,
    Path(uuid): Path<String>,
) -> Result<Json<AccountDto>, ApiError> {
    require_admin(&state, &headers).await?;
    state
        .store
        .set_telegram(&uuid, None)
        .await
        .map_err(map_store)?;
    let account = state
        .store
        .find_by_uuid(&uuid)
        .await
        .ok_or_else(|| ApiError::new(StatusCode::NOT_FOUND, "Аккаунт не найден"))?;
    Ok(Json(AccountDto::from(account)))
}

#[derive(Deserialize)]
struct SetTelegramRequest {
    chat_id: Option<String>,
}

async fn set_account_telegram(
    State(state): State<Shared>,
    headers: HeaderMap,
    Path(uuid): Path<String>,
    Json(req): Json<SetTelegramRequest>,
) -> Result<Json<AccountDto>, ApiError> {
    require_admin(&state, &headers).await?;
    state
        .store
        .set_telegram(&uuid, req.chat_id.as_deref())
        .await
        .map_err(map_store)?;
    let account = state
        .store
        .find_by_uuid(&uuid)
        .await
        .ok_or_else(|| ApiError::new(StatusCode::NOT_FOUND, "Аккаунт не найден"))?;
    Ok(Json(AccountDto::from(account)))
}

/// `GET /api/accounts/:uuid/skin` — PNG-скин аккаунта для аватарки в админке.
///
/// Скины хранятся в общем `store` (та же БД, что у auth-server), поэтому
/// отдаём их прямо отсюда — отдельный поход в auth-server не нужен. Модель
/// (`classic`/`slim`) кладём в заголовок `X-Skin-Model`. Если скина нет — 404,
/// фронт показывает буквенный плейсхолдер.
async fn account_skin(
    State(state): State<Shared>,
    headers: HeaderMap,
    Path(uuid): Path<String>,
) -> Result<Response, ApiError> {
    require_admin(&state, &headers).await?;
    let account = state
        .store
        .find_by_uuid(&uuid)
        .await
        .ok_or_else(|| ApiError::new(StatusCode::NOT_FOUND, "Аккаунт не найден"))?;
    let skin = account
        .skin
        .ok_or_else(|| ApiError::new(StatusCode::NOT_FOUND, "Скин не задан"))?;
    let model = match skin.model {
        protocol::SkinModel::Slim => "slim",
        protocol::SkinModel::Classic => "classic",
    };
    Ok((
        StatusCode::OK,
        [
            (header::CONTENT_TYPE, "image/png"),
            (header::CACHE_CONTROL, "no-cache"),
            (header::HeaderName::from_static("x-skin-model"), model),
        ],
        skin.png,
    )
        .into_response())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct UpdateAccountSkinRequest {
    png_base64: String,
    model: protocol::SkinModel,
}

/// `PUT /api/accounts/:uuid/skin` — администратор задаёт PNG-скин игроку.
/// Ручная загрузка сбрасывает импорт Mojang и связанный плащ, как и в API лаунчера.
async fn update_account_skin(
    State(state): State<Shared>,
    headers: HeaderMap,
    Path(uuid): Path<String>,
    Json(req): Json<UpdateAccountSkinRequest>,
) -> Result<Json<AccountDto>, ApiError> {
    use base64::Engine;

    require_admin(&state, &headers).await?;
    let account = state
        .store
        .find_by_uuid(&uuid)
        .await
        .ok_or_else(|| ApiError::new(StatusCode::NOT_FOUND, "Аккаунт не найден"))?;

    let png = base64::engine::general_purpose::STANDARD
        .decode(req.png_base64.trim().as_bytes())
        .map_err(|_| ApiError::new(StatusCode::BAD_REQUEST, "Не удалось декодировать PNG"))?;
    const MAX_SKIN_BYTES: usize = 256 * 1024;
    if png.len() > MAX_SKIN_BYTES {
        return Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            "Скин слишком большой (максимум 256 КБ)",
        ));
    }
    if png.len() < 8 || png[..8] != [0x89, b'P', b'N', b'G', b'\r', b'\n', 0x1a, b'\n'] {
        return Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            "Файл не является PNG",
        ));
    }

    state
        .store
        .set_skin(
            &account.uuid,
            store::StoredSkin::new(png, req.model, None, None),
        )
        .await
        .map_err(map_store)?;
    Ok(Json(AccountDto::from(account)))
}

struct MinecraftStats {
    playtime_ticks: i64,
    deaths: i64,
    blocks_mined: i64,
    distance_cm: i64,
}

fn sum_stat_group(value: Option<&serde_json::Value>) -> i64 {
    value
        .and_then(serde_json::Value::as_object)
        .map(|stats| {
            stats
                .values()
                .filter_map(serde_json::Value::as_i64)
                .fold(0i64, i64::saturating_add)
        })
        .unwrap_or(0)
}

fn parse_minecraft_stats(json: &serde_json::Value) -> MinecraftStats {
    let custom = json.pointer("/stats/minecraft:custom");
    let playtime_ticks = custom
        .and_then(|stats| stats.get("minecraft:play_time"))
        .or_else(|| custom.and_then(|stats| stats.get("minecraft:play_one_minute")))
        .and_then(serde_json::Value::as_i64)
        .unwrap_or(0);
    let distance_cm = custom
        .and_then(serde_json::Value::as_object)
        .map(|stats| {
            stats
                .iter()
                .filter(|(name, _)| name.ends_with("_one_cm"))
                .filter_map(|(_, value)| value.as_i64())
                .fold(0i64, i64::saturating_add)
        })
        .unwrap_or(0);
    MinecraftStats {
        playtime_ticks,
        deaths: custom
            .and_then(|stats| stats.get("minecraft:deaths"))
            .and_then(serde_json::Value::as_i64)
            .unwrap_or(0),
        blocks_mined: sum_stat_group(json.pointer("/stats/minecraft:mined")),
        distance_cm,
    }
}

/// Внутренняя логика синхронизации статистики с SFTP.
/// Возвращает количество обновлённых аккаунтов.
async fn do_sync_stats(state: &Shared) -> Result<usize, String> {
    let host = state
        .store
        .get_setting(SETTING_SFTP_HOST)
        .await
        .map_err(|e| format!("{e}"))?
        .filter(|s| !s.trim().is_empty())
        .ok_or_else(|| "sftpHost не задан".to_string())?;
    let username = state
        .store
        .get_setting(SETTING_SFTP_USERNAME)
        .await
        .map_err(|e| format!("{e}"))?
        .filter(|s| !s.trim().is_empty())
        .ok_or_else(|| "sftpUsername не задан".to_string())?;
    let password = state
        .store
        .get_setting(SETTING_SFTP_PASSWORD)
        .await
        .map_err(|e| format!("{e}"))?
        .filter(|s| !s.trim().is_empty())
        .ok_or_else(|| "sftpPassword не задан".to_string())?;
    let stats_path = state
        .store
        .get_setting(SETTING_SFTP_STATS_PATH)
        .await
        .map_err(|e| format!("{e}"))?
        .filter(|s| !s.trim().is_empty())
        .ok_or_else(|| "sftpStatsPath не задан".to_string())?;

    let (host_part, port) = match host.rsplit_once(':') {
        Some((h, p)) => match p.parse::<u16>() {
            Ok(port) => (h.to_string(), port),
            Err(_) => (host.clone(), 22),
        },
        None => (host.clone(), 22),
    };

    let config = Arc::new(russh::client::Config::default());
    let mut session = russh::client::connect(
        config,
        (host_part.as_str(), port),
        SftpHandler::new(&state.modpack_dir, &format!("{host_part}:{port}")),
    )
    .await
    .map_err(|e| format!("SSH-подключение к {host_part}:{port}: {e}"))?;
    let auth = session
        .authenticate_password(&username, &password)
        .await
        .map_err(|e| format!("SSH-аутентификация: {e}"))?;
    if !auth.success() {
        return Err("SFTP-аутентификация не прошла".into());
    }

    let channel = session
        .channel_open_session()
        .await
        .map_err(|e| format!("открытие канала: {e}"))?;
    channel
        .request_subsystem(true, "sftp")
        .await
        .map_err(|e| format!("запуск sftp-подсистемы: {e}"))?;
    let sftp = russh_sftp::client::SftpSession::new(channel.into_stream())
        .await
        .map_err(|e| format!("инициализация SFTP: {e}"))?;

    let entries = sftp
        .read_dir(&stats_path)
        .await
        .map_err(|e| format!("чтение папки {stats_path}: {e}"))?;

    let mut updated = 0usize;
    for entry in entries {
        let name = entry.file_name();
        let Some(uuid) = name.strip_suffix(".json") else {
            continue;
        };
        let path = format!("{}/{}", stats_path.trim_end_matches('/'), name);
        let bytes = match sftp.read(&path).await {
            Ok(b) => b,
            Err(_) => continue,
        };
        let Ok(json) = serde_json::from_slice::<serde_json::Value>(&bytes) else {
            continue;
        };
        let stats = parse_minecraft_stats(&json);
        if state
            .store
            .set_playtime_absolute(uuid, stats.playtime_ticks / 20)
            .await
            .is_err()
        {
            continue;
        }
        if state
            .store
            .set_player_stats_absolute(uuid, stats.deaths, stats.blocks_mined, stats.distance_cm)
            .await
            .is_ok()
        {
            updated += 1;
        }
    }

    let _ = session
        .disconnect(russh::Disconnect::ByApplication, "", "en")
        .await;

    Ok(updated)
}

/// `POST /api/settings/sync-stats` — ручной запуск синхронизации статистики.
async fn sync_stats(
    State(state): State<Shared>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, ApiError> {
    require_admin(&state, &headers).await?;
    let updated = do_sync_stats(&state)
        .await
        .map_err(|e| ApiError::new(StatusCode::BAD_REQUEST, e))?;
    Ok(Json(serde_json::json!({ "updated": updated })))
}

/// `GET /api/accounts/:uuid/stats` — время игры и дата последнего захода на сервер.
async fn account_stats(
    State(state): State<Shared>,
    headers: HeaderMap,
    Path(uuid): Path<String>,
) -> Result<Json<protocol::PlayerStats>, ApiError> {
    require_admin(&state, &headers).await?;
    let (playtime_seconds, last_joined_at) =
        state.store.get_playtime(&uuid).await.map_err(map_store)?;
    Ok(Json(protocol::PlayerStats {
        playtime_seconds,
        last_joined_at: last_joined_at.map(|t| t.format(&Rfc3339).unwrap_or_default()),
    }))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CoinGrantInput {
    amount: i64,
    reason: String,
    idempotency_key: String,
}

async fn grant_account_coins(
    State(state): State<Shared>,
    headers: HeaderMap,
    Path(uuid): Path<String>,
    Json(input): Json<CoinGrantInput>,
) -> Result<Json<serde_json::Value>, ApiError> {
    require_admin(&state, &headers).await?;
    let balance = state
        .store
        .grant_coins(&uuid, input.amount, &input.reason, &input.idempotency_key)
        .await
        .map_err(map_store)?;
    Ok(Json(serde_json::json!({ "balance": balance })))
}

async fn server_telemetry(
    State(state): State<Shared>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, ApiError> {
    require_admin(&state, &headers).await?;
    let since = OffsetDateTime::now_utc() - time::Duration::hours(24);
    let samples = state
        .store
        .telemetry_samples_since(since)
        .await
        .map_err(map_store)?;
    let events = state
        .store
        .player_events_since(since)
        .await
        .map_err(map_store)?;
    let average_online = state
        .store
        .telemetry_average_online()
        .await
        .map_err(map_store)?;
    Ok(Json(serde_json::json!({
        "samples": samples,
        "events": events,
        "averageOnline": average_online,
    })))
}

async fn server_logs(
    State(state): State<Shared>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, ApiError> {
    require_admin(&state, &headers).await?;
    let since = OffsetDateTime::now_utc() - time::Duration::days(30);
    let (logs, average_online) = tokio::try_join!(
        state.store.server_log_summaries_since(since),
        state.store.telemetry_average_online(),
    )
    .map_err(map_store)?;
    Ok(Json(serde_json::json!({
        "logs": logs,
        "averageOnline": average_online,
    })))
}

async fn server_log(
    State(state): State<Shared>,
    headers: HeaderMap,
    Path(id): Path<i64>,
) -> Result<Json<store::server_telemetry::ServerLogEntry>, ApiError> {
    require_admin(&state, &headers).await?;
    let log = state.store.server_log(id).await.map_err(map_store)?;
    Ok(Json(log))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ExternalModAllowlistInput {
    mod_id: String,
    jar_name: String,
    sha256: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ExternalModBlockRuleInput {
    sha256: Option<String>,
    name_substring: Option<String>,
}

async fn list_external_mod_allowlist(
    State(state): State<Shared>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, ApiError> {
    require_admin(&state, &headers).await?;
    Ok(Json(serde_json::json!({
        "entries": state.store.list_external_mod_allowlist().await.map_err(map_store)?,
    })))
}

async fn add_external_mod_allowlist(
    State(state): State<Shared>,
    headers: HeaderMap,
    Json(input): Json<ExternalModAllowlistInput>,
) -> Result<StatusCode, ApiError> {
    require_admin(&state, &headers).await?;
    let mod_id = input.mod_id.trim();
    let jar_name = input.jar_name.trim();
    let sha256 = input.sha256.trim().to_ascii_lowercase();
    if mod_id.is_empty()
        || jar_name.is_empty()
        || !sha256.chars().all(|ch| ch.is_ascii_hexdigit())
        || sha256.len() != 64
    {
        return Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            "Некорректные данные allowlist",
        ));
    }
    state
        .store
        .add_external_mod_allowlist(mod_id, jar_name, &sha256)
        .await
        .map_err(map_store)?;
    Ok(StatusCode::NO_CONTENT)
}

async fn remove_external_mod_allowlist(
    State(state): State<Shared>,
    headers: HeaderMap,
    Path(id): Path<i64>,
) -> Result<StatusCode, ApiError> {
    require_admin(&state, &headers).await?;
    state
        .store
        .remove_external_mod_allowlist(id)
        .await
        .map_err(map_store)?;
    Ok(StatusCode::NO_CONTENT)
}

async fn list_external_mod_block_rules(
    State(state): State<Shared>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, ApiError> {
    require_admin(&state, &headers).await?;
    Ok(Json(serde_json::json!({
        "rules": state.store.list_external_mod_block_rules().await.map_err(map_store)?,
    })))
}

async fn add_external_mod_block_rule(
    State(state): State<Shared>,
    headers: HeaderMap,
    Json(input): Json<ExternalModBlockRuleInput>,
) -> Result<StatusCode, ApiError> {
    require_admin(&state, &headers).await?;
    let sha256 = input
        .sha256
        .as_deref()
        .map(str::trim)
        .map(str::to_ascii_lowercase);
    let sha256 = sha256.filter(|value| !value.is_empty());
    if let Some(value) = sha256.as_deref() {
        if value.len() != 64 || !value.chars().all(|ch| ch.is_ascii_hexdigit()) {
            return Err(ApiError::new(
                StatusCode::BAD_REQUEST,
                "Некорректный SHA-256 правила блокировки",
            ));
        }
    }
    let name_substring = input
        .name_substring
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());
    if sha256.is_none() && name_substring.is_none() {
        return Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            "Нужно указать SHA-256 или подстроку имени",
        ));
    }
    state
        .store
        .add_external_mod_block_rule(sha256.as_deref(), name_substring)
        .await
        .map_err(map_store)?;
    Ok(StatusCode::NO_CONTENT)
}

async fn remove_external_mod_block_rule(
    State(state): State<Shared>,
    headers: HeaderMap,
    Path(id): Path<i64>,
) -> Result<StatusCode, ApiError> {
    require_admin(&state, &headers).await?;
    state
        .store
        .remove_external_mod_block_rule(id)
        .await
        .map_err(map_store)?;
    Ok(StatusCode::NO_CONTENT)
}

// ───────────────────────── Гайды ─────────────────────────

#[derive(Deserialize)]
struct GuideInput {
    slug: String,
    title: String,
    excerpt: String,
    category: String,
    markdown: String,
    published: bool,
}

async fn public_leaderboards(
    State(state): State<Shared>,
) -> Result<Json<protocol::Leaderboards>, ApiError> {
    let to_entries = |rows: Vec<(i64, String, i64)>| {
        rows.into_iter()
            .map(|(rank, username, value)| protocol::LeaderboardEntry {
                rank,
                username,
                value,
            })
            .collect()
    };
    let playtime = to_entries(
        state
            .store
            .playtime_leaderboard(10)
            .await
            .map_err(map_store)?,
    );
    let deaths = to_entries(
        state
            .store
            .deaths_leaderboard(10)
            .await
            .map_err(map_store)?,
    );
    let blocks_mined = to_entries(
        state
            .store
            .blocks_mined_leaderboard(10)
            .await
            .map_err(map_store)?,
    );
    let distance = to_entries(
        state
            .store
            .distance_leaderboard(10)
            .await
            .map_err(map_store)?,
    );
    Ok(Json(protocol::Leaderboards {
        playtime,
        deaths,
        blocks_mined,
        distance,
    }))
}

async fn public_guides(
    State(state): State<Shared>,
) -> Result<Json<Vec<protocol::Guide>>, ApiError> {
    let guides = state.store.list_guides(true).await.map_err(map_store)?;
    Ok(Json(guides.into_iter().map(guide_to_dto).collect()))
}

async fn public_guide(
    State(state): State<Shared>,
    Path(slug): Path<String>,
) -> Result<Json<protocol::Guide>, ApiError> {
    let guide = state
        .store
        .get_guide_by_slug(&slug)
        .await
        .map_err(map_store)?;
    Ok(Json(guide_to_dto(guide)))
}

async fn list_guides(
    State(state): State<Shared>,
    headers: HeaderMap,
) -> Result<Json<Vec<protocol::Guide>>, ApiError> {
    require_admin(&state, &headers).await?;
    let guides = state.store.list_guides(false).await.map_err(map_store)?;
    Ok(Json(guides.into_iter().map(guide_to_dto).collect()))
}

async fn create_guide(
    State(state): State<Shared>,
    headers: HeaderMap,
    Json(input): Json<GuideInput>,
) -> Result<Json<protocol::Guide>, ApiError> {
    let author = require_admin(&state, &headers).await?;
    let input = validate_guide_input(&input)?;
    let guide = state
        .store
        .create_guide(
            &input.slug,
            &input.title,
            &input.excerpt,
            &input.category,
            &input.markdown,
            &author.username,
            input.published,
        )
        .await
        .map_err(map_store)?;
    Ok(Json(guide_to_dto(guide)))
}

async fn update_guide(
    State(state): State<Shared>,
    headers: HeaderMap,
    Path(id): Path<i64>,
    Json(input): Json<GuideInput>,
) -> Result<Json<protocol::Guide>, ApiError> {
    require_admin(&state, &headers).await?;
    let input = validate_guide_input(&input)?;
    let guide = state
        .store
        .update_guide(
            id,
            &input.slug,
            &input.title,
            &input.excerpt,
            &input.category,
            &input.markdown,
            input.published,
        )
        .await
        .map_err(map_store)?;
    Ok(Json(guide_to_dto(guide)))
}

async fn delete_guide(
    State(state): State<Shared>,
    headers: HeaderMap,
    Path(id): Path<i64>,
) -> Result<(), ApiError> {
    require_admin(&state, &headers).await?;
    state.store.delete_guide(id).await.map_err(map_store)
}

fn validate_guide_input(input: &GuideInput) -> Result<GuideInput, ApiError> {
    let slug = input.slug.trim().to_ascii_lowercase();
    let title = input.title.trim();
    let excerpt = input.excerpt.trim();
    let category = input.category.trim();
    let markdown = input.markdown.trim();
    if slug.is_empty() || title.is_empty() || markdown.is_empty() {
        return Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            "Заполните slug, заголовок и текст гайда",
        ));
    }
    if !slug
        .chars()
        .all(|ch| ch.is_ascii_lowercase() || ch.is_ascii_digit() || ch == '-')
        || slug.starts_with('-')
        || slug.ends_with('-')
        || slug.contains("--")
    {
        return Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            "Slug: только латиница, цифры и одиночные дефисы",
        ));
    }
    if slug.chars().count() > MAX_GUIDE_SLUG_CHARS
        || title.chars().count() > MAX_GUIDE_TITLE_CHARS
        || excerpt.chars().count() > MAX_GUIDE_EXCERPT_CHARS
        || markdown.chars().count() > MAX_GUIDE_MARKDOWN_CHARS
    {
        return Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            "Гайд превышает допустимый размер",
        ));
    }
    Ok(GuideInput {
        slug,
        title: title.to_owned(),
        excerpt: excerpt.to_owned(),
        category: if category.is_empty() {
            "Общее".into()
        } else {
            category.to_owned()
        },
        markdown: markdown.to_owned(),
        published: input.published,
    })
}

fn guide_to_dto(guide: store::Guide) -> protocol::Guide {
    protocol::Guide {
        id: guide.id,
        slug: guide.slug,
        title: guide.title,
        excerpt: guide.excerpt,
        category: guide.category,
        markdown: guide.markdown,
        author_name: guide.author_name,
        published: guide.published,
        created_at: guide.created_at,
        updated_at: guide.updated_at,
    }
}

// ───────────────────────── Новости ─────────────────────────

#[derive(Deserialize)]
struct NewsInput {
    title: String,
    markdown: String,
    pinned: bool,
}

async fn news_highlight(
    State(state): State<Shared>,
) -> Result<Json<protocol::NewsHighlight>, ApiError> {
    Ok(Json(state.store.news_highlight().await.map_err(map_store)?))
}

async fn public_news(
    State(state): State<Shared>,
) -> Result<Json<Vec<protocol::NewsPost>>, ApiError> {
    let posts = state.store.list_news().await.map_err(map_store)?;
    Ok(Json(posts.into_iter().map(news_to_dto).collect()))
}

async fn list_news(
    State(state): State<Shared>,
    headers: HeaderMap,
) -> Result<Json<Vec<protocol::NewsPost>>, ApiError> {
    require_admin(&state, &headers).await?;
    let posts = state.store.list_news().await.map_err(map_store)?;
    Ok(Json(posts.into_iter().map(news_to_dto).collect()))
}

async fn create_news(
    State(state): State<Shared>,
    headers: HeaderMap,
    Json(input): Json<NewsInput>,
) -> Result<Json<protocol::NewsPost>, ApiError> {
    let author = require_admin(&state, &headers).await?;
    let (title, markdown) = validate_news_input(&input)?;
    let post = state
        .store
        .create_news(&title, &markdown, &author.username, input.pinned)
        .await
        .map_err(map_store)?;
    Ok(Json(news_to_dto(post)))
}

async fn update_news(
    State(state): State<Shared>,
    headers: HeaderMap,
    Path(id): Path<i64>,
    Json(input): Json<NewsInput>,
) -> Result<Json<protocol::NewsPost>, ApiError> {
    require_admin(&state, &headers).await?;
    let (title, markdown) = validate_news_input(&input)?;
    let post = state
        .store
        .update_news(id, &title, &markdown, input.pinned)
        .await
        .map_err(map_store)?;
    Ok(Json(news_to_dto(post)))
}

async fn delete_news(
    State(state): State<Shared>,
    headers: HeaderMap,
    Path(id): Path<i64>,
) -> Result<(), ApiError> {
    require_admin(&state, &headers).await?;
    state.store.delete_news(id).await.map_err(map_store)
}

fn validate_news_input(input: &NewsInput) -> Result<(String, String), ApiError> {
    let title = input.title.trim();
    let markdown = input.markdown.trim();
    if title.is_empty() || markdown.is_empty() {
        return Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            "Заполните заголовок и текст новости",
        ));
    }
    if title.chars().count() > MAX_NEWS_TITLE_CHARS {
        return Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            "Заголовок не должен быть длиннее 120 символов",
        ));
    }
    if markdown.chars().count() > MAX_NEWS_MARKDOWN_CHARS {
        return Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            "Текст новости не должен быть длиннее 12 000 символов",
        ));
    }
    Ok((title.to_owned(), markdown.to_owned()))
}

fn news_to_dto(post: store::NewsPost) -> protocol::NewsPost {
    protocol::NewsPost {
        id: post.id,
        title: post.title,
        markdown: post.markdown,
        author_name: post.author_name,
        pinned: post.pinned,
        created_at: post.created_at,
        updated_at: post.updated_at,
    }
}

// ─────────────────── Бейджи и градиенты (CRUD) ───────────────────

#[derive(Deserialize)]
struct BadgeInput {
    emoji: String,
    label: String,
    description: String,
    color: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GradientInput {
    label: String,
    description: String,
    color_start: String,
    color_end: String,
}

#[derive(Deserialize)]
struct IdList {
    ids: Vec<i32>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ActiveInput {
    badge_id: Option<i32>,
    gradient_id: Option<i32>,
}

async fn list_badges(
    State(state): State<Shared>,
    headers: HeaderMap,
) -> Result<Json<Vec<protocol::Badge>>, ApiError> {
    require_admin(&state, &headers).await?;
    let badges = state.store.list_badges().await.map_err(map_store)?;
    Ok(Json(badges))
}

async fn create_badge(
    State(state): State<Shared>,
    headers: HeaderMap,
    Json(input): Json<BadgeInput>,
) -> Result<Json<protocol::Badge>, ApiError> {
    require_admin(&state, &headers).await?;
    let badge = state
        .store
        .create_badge(&input.emoji, &input.label, &input.description, &input.color)
        .await
        .map_err(map_store)?;
    Ok(Json(badge))
}

async fn update_badge(
    State(state): State<Shared>,
    headers: HeaderMap,
    Path(id): Path<i32>,
    Json(input): Json<BadgeInput>,
) -> Result<(), ApiError> {
    require_admin(&state, &headers).await?;
    state
        .store
        .update_badge(
            id,
            &input.emoji,
            &input.label,
            &input.description,
            &input.color,
        )
        .await
        .map_err(map_store)?;
    Ok(())
}

async fn delete_badge(
    State(state): State<Shared>,
    headers: HeaderMap,
    Path(id): Path<i32>,
) -> Result<(), ApiError> {
    require_admin(&state, &headers).await?;
    state.store.delete_badge(id).await.map_err(map_store)?;
    Ok(())
}

async fn list_gradients(
    State(state): State<Shared>,
    headers: HeaderMap,
) -> Result<Json<Vec<protocol::Gradient>>, ApiError> {
    require_admin(&state, &headers).await?;
    let gradients = state.store.list_gradients().await.map_err(map_store)?;
    Ok(Json(gradients))
}

async fn create_gradient(
    State(state): State<Shared>,
    headers: HeaderMap,
    Json(input): Json<GradientInput>,
) -> Result<Json<protocol::Gradient>, ApiError> {
    require_admin(&state, &headers).await?;
    let gradient = state
        .store
        .create_gradient(
            &input.label,
            &input.description,
            &input.color_start,
            &input.color_end,
        )
        .await
        .map_err(map_store)?;
    Ok(Json(gradient))
}

async fn update_gradient(
    State(state): State<Shared>,
    headers: HeaderMap,
    Path(id): Path<i32>,
    Json(input): Json<GradientInput>,
) -> Result<(), ApiError> {
    require_admin(&state, &headers).await?;
    state
        .store
        .update_gradient(
            id,
            &input.label,
            &input.description,
            &input.color_start,
            &input.color_end,
        )
        .await
        .map_err(map_store)?;
    Ok(())
}

async fn delete_gradient(
    State(state): State<Shared>,
    headers: HeaderMap,
    Path(id): Path<i32>,
) -> Result<(), ApiError> {
    require_admin(&state, &headers).await?;
    state.store.delete_gradient(id).await.map_err(map_store)?;
    Ok(())
}

async fn get_account_customization(
    State(state): State<Shared>,
    headers: HeaderMap,
    Path(uuid): Path<String>,
) -> Result<Json<protocol::PlayerCustomization>, ApiError> {
    require_admin(&state, &headers).await?;
    let account = state
        .store
        .find_by_uuid(&uuid)
        .await
        .ok_or_else(|| ApiError::new(StatusCode::NOT_FOUND, "Аккаунт не найден"))?;
    let owned_badges = state
        .store
        .player_available_badges(&uuid)
        .await
        .map_err(map_store)?;
    let owned_gradients = state
        .store
        .player_available_gradients(&uuid)
        .await
        .map_err(map_store)?;
    let owned_badge_ids = owned_badges.iter().map(|b| b.id).collect();
    let owned_gradient_ids = owned_gradients.iter().map(|g| g.id).collect();
    let available_badges = state.store.list_badges().await.map_err(map_store)?;
    let available_gradients = state.store.list_gradients().await.map_err(map_store)?;
    Ok(Json(protocol::PlayerCustomization {
        available_badges,
        available_gradients,
        active_badge_id: account.active_badge_id,
        active_gradient_id: account.active_gradient_id,
        owned_badge_ids: Some(owned_badge_ids),
        owned_gradient_ids: Some(owned_gradient_ids),
    }))
}

async fn set_account_badges(
    State(state): State<Shared>,
    headers: HeaderMap,
    Path(uuid): Path<String>,
    Json(input): Json<IdList>,
) -> Result<(), ApiError> {
    require_admin(&state, &headers).await?;
    state
        .store
        .set_player_badges(&uuid, &input.ids)
        .await
        .map_err(map_store)?;
    Ok(())
}

async fn set_account_gradients(
    State(state): State<Shared>,
    headers: HeaderMap,
    Path(uuid): Path<String>,
    Json(input): Json<IdList>,
) -> Result<(), ApiError> {
    require_admin(&state, &headers).await?;
    state
        .store
        .set_player_gradients(&uuid, &input.ids)
        .await
        .map_err(map_store)?;
    Ok(())
}

async fn set_account_active(
    State(state): State<Shared>,
    headers: HeaderMap,
    Path(uuid): Path<String>,
    Json(input): Json<ActiveInput>,
) -> Result<(), ApiError> {
    require_admin(&state, &headers).await?;
    state
        .store
        .set_active_customization(&uuid, input.badge_id, input.gradient_id)
        .await
        .map_err(map_store)?;
    Ok(())
}

/// Нормализует UUID для сравнения (убирает дефисы, нижний регистр).
fn normalize_for_compare(uuid: &str) -> String {
    uuid.chars()
        .filter(|c| *c != '-')
        .flat_map(char::to_lowercase)
        .collect()
}

// ───────────────────────── Манифест (для лаунчера) ─────────────────────────

/// Клиентский манифест активной сборки. Публичный (без авторизации).
async fn manifest(State(state): State<Shared>) -> Result<Json<protocol::Manifest>, ApiError> {
    let record = state
        .store
        .active_build()
        .await
        .map_err(internal)?
        .ok_or_else(|| ApiError::new(StatusCode::NOT_FOUND, "Нет активной сборки"))?;
    let mut manifest = record.client_manifest(&state.files_base_url);
    manifest.external_mod_policy = Some(state.store.external_mod_policy().await.map_err(internal)?);
    Ok(Json(manifest))
}

// ───────────────────── проверка сборки ─────────────────────

/// `GET /api/build-check` — проверяет что все файлы активной сборки лежат на диске.
///
/// Для каждого файла сборки проверяет наличие `<modpack_dir>/<sha1>` и размер.
/// Возвращает список проблем (если есть) или пустой массив.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct BuildCheckResult {
    build_id: i64,
    build_name: String,
    total_files: usize,
    problems: Vec<BuildCheckProblem>,
}

#[derive(Serialize)]
struct BuildCheckProblem {
    path: String,
    sha1: String,
    kind: String, // "missing" | "size_mismatch"
    detail: String,
}

/// Опциональный `build_id` для проверки конкретной сборки (не обязательно активной).
#[derive(Deserialize)]
struct BuildCheckQuery {
    build_id: Option<i64>,
}

async fn build_check(
    State(state): State<Shared>,
    headers: HeaderMap,
    Query(q): Query<BuildCheckQuery>,
) -> Result<Json<BuildCheckResult>, ApiError> {
    require_admin(&state, &headers).await?;

    let record = if let Some(id) = q.build_id {
        state
            .store
            .get_build(id)
            .await
            .map_err(internal)?
            .ok_or_else(|| ApiError::new(StatusCode::NOT_FOUND, "Сборка не найдена"))?
    } else {
        state
            .store
            .active_build()
            .await
            .map_err(internal)?
            .ok_or_else(|| ApiError::new(StatusCode::NOT_FOUND, "Нет активной сборки"))?
    };

    let files = state
        .store
        .build_files(record.header.id)
        .await
        .map_err(internal)?;

    let mut problems = Vec::new();

    for f in &files {
        let path = state.modpack_dir.join(&f.sha1);
        match std::fs::metadata(&path) {
            Ok(meta) => {
                let disk_size = meta.len() as i64;
                if disk_size != f.size_bytes {
                    problems.push(BuildCheckProblem {
                        path: f.path.clone(),
                        sha1: f.sha1.clone(),
                        kind: "size_mismatch".into(),
                        detail: format!("ожидается {} байт, на диске {}", f.size_bytes, disk_size),
                    });
                }
            }
            Err(_) => {
                problems.push(BuildCheckProblem {
                    path: f.path.clone(),
                    sha1: f.sha1.clone(),
                    kind: "missing".into(),
                    // Без абсолютного пути сервера — только факт отсутствия по sha1.
                    detail: format!("файл не найден в хранилище (sha1={})", f.sha1),
                });
            }
        }
    }

    Ok(Json(BuildCheckResult {
        build_id: record.header.id,
        build_name: record.header.name.clone(),
        total_files: files.len(),
        problems,
    }))
}

// ───────────────────── проверка зависимостей модов ─────────────────────

/// Встроенные modId, которые не являются модами и не проверяются.
const BUILTIN_MOD_IDS: &[&str] = &[
    "neoforge",
    "minecraft",
    "java",
    "forge",
    "fabricloader",
    "fabric-api",
    "rift",
    "quilt_loader",
];

/// `GET /api/deps-check` — проверяет зависимости модов в активной сборке.
///
/// Читает `META-INF/neoforge.mods.toml` из каждого мод-JAR, парсит
/// `[[dependencies]]` и проверяет что все `type = "required"` зависимости
/// выполнены (есть другой мод с таким `modId` в сборке).
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DepsCheckResult {
    build_id: i64,
    build_name: String,
    total_mods: usize,
    problems: Vec<DepsCheckProblem>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DepsCheckProblem {
    /// Мод, у которого не выполнена зависимость.
    from_mod: String,
    /// Какой modId требуется.
    required_mod: String,
    /// Версионный диапазон из TOML.
    version_range: String,
    /// Тип зависимости (optional, incompatible, etc.).
    dep_type: String,
}

/// Извлекает modId из `[[mods]]` секции `neoforge.mods.toml`.
fn extract_mod_ids(toml_text: &str) -> Vec<String> {
    let Ok(val) = toml::Value::from_str(toml_text) else {
        return Vec::new();
    };
    let Some(mods) = val.get("mods").and_then(|v| v.as_array()) else {
        return Vec::new();
    };
    mods.iter()
        .filter_map(|m| m.get("modId")?.as_str().map(|s| s.to_string()))
        .collect()
}

/// Извлекает зависимости из `[[dependencies.<modId>]]` секций.
/// Возвращает vec![(declaring_mod, required_mod, version_range, dep_type)].
fn extract_dependencies(toml_text: &str) -> Vec<(String, String, String, String)> {
    let Ok(val) = toml::Value::from_str(toml_text) else {
        return Vec::new();
    };
    let Some(deps_table) = val.get("dependencies").and_then(|v| v.as_table()) else {
        return Vec::new();
    };

    let mut result = Vec::new();
    for (declaring_mod, entries) in deps_table {
        let Some(arr) = entries.as_array() else {
            continue;
        };
        for entry in arr {
            let req_mod = match entry.get("modId").and_then(|v| v.as_str()) {
                Some(s) => s.to_string(),
                None => continue,
            };
            let version_range = entry
                .get("versionRange")
                .and_then(|v| v.as_str())
                .unwrap_or("*")
                .to_string();
            let dep_type = entry
                .get("type")
                .and_then(|v| v.as_str())
                .unwrap_or("required")
                .to_string();
            result.push((declaring_mod.clone(), req_mod, version_range, dep_type));
        }
    }
    result
}

/// Читает `neoforge.mods.toml` из JAR-файла по пути на диске.
fn read_neoforge_toml(jar_path: &std::path::Path) -> Option<String> {
    let file = std::fs::File::open(jar_path).ok()?;
    let mut zip = zip::ZipArchive::new(file).ok()?;

    for name in &["META-INF/neoforge.mods.toml", "META-INF/mods.toml"] {
        if let Ok(mut entry) = zip.by_name(name) {
            let mut buf = String::new();
            use std::io::Read;
            if entry.read_to_string(&mut buf).is_ok() {
                return Some(buf);
            }
        }
    }
    None
}

async fn deps_check(
    State(state): State<Shared>,
    headers: HeaderMap,
    Query(q): Query<BuildCheckQuery>,
) -> Result<Json<DepsCheckResult>, ApiError> {
    require_admin(&state, &headers).await?;

    let record = if let Some(id) = q.build_id {
        state
            .store
            .get_build(id)
            .await
            .map_err(internal)?
            .ok_or_else(|| ApiError::new(StatusCode::NOT_FOUND, "Сборка не найдена"))?
    } else {
        state
            .store
            .active_build()
            .await
            .map_err(internal)?
            .ok_or_else(|| ApiError::new(StatusCode::NOT_FOUND, "Нет активной сборки"))?
    };

    let files = state
        .store
        .build_files(record.header.id)
        .await
        .map_err(internal)?;

    // Собираем modId → путь для каждого мода в сборке.
    let mod_jars: Vec<(String, std::path::PathBuf)> = files
        .iter()
        .filter(|f| f.path.ends_with(".jar") && (f.side == "client" || f.side == "both"))
        .map(|f| (f.path.clone(), state.modpack_dir.join(&f.sha1)))
        .collect();

    // Читаем metadatas: modId → (jar_path, provided_mod_ids, raw_toml).
    let mut all_provided: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut mod_entries: Vec<(String, std::path::PathBuf, Vec<String>, String)> = Vec::new();

    for (path, jar_path) in &mod_jars {
        let Some(toml_text) = read_neoforge_toml(jar_path) else {
            continue;
        };
        let mod_ids = extract_mod_ids(&toml_text);
        for id in &mod_ids {
            all_provided.insert(id.clone());
        }
        mod_entries.push((path.clone(), jar_path.clone(), mod_ids, toml_text));
    }

    let mut problems = Vec::new();

    for (path, _jar_path, mod_ids, toml_text) in &mod_entries {
        let deps = extract_dependencies(toml_text);
        for (_declaring, req_mod, version_range, dep_type) in deps {
            // Проверяем только required зависимости.
            if dep_type != "required" {
                continue;
            }
            // Пропускаем встроенные.
            if BUILTIN_MOD_IDS.contains(&req_mod.as_str()) {
                continue;
            }
            // Пропускаем зависимости на самого себя.
            if mod_ids.contains(&req_mod) {
                continue;
            }
            // Проверяем наличие в сборке.
            if !all_provided.contains(&req_mod) {
                problems.push(DepsCheckProblem {
                    from_mod: path.clone(),
                    required_mod: req_mod,
                    version_range,
                    dep_type,
                });
            }
        }
    }

    Ok(Json(DepsCheckResult {
        build_id: record.header.id,
        build_name: record.header.name.clone(),
        total_mods: mod_jars.len(),
        problems,
    }))
}

// ───────────────────── authlib-injector ─────────────────────

/// Возвращает метаданные последней опубликованной StarDust-сборки.
///
/// Если старый deployment ещё не публикует JSON, используются значения из
/// переменных окружения, поэтому существующий `/authlib-injector.jar` остаётся
/// совместимым.
async fn resolve_injector_metadata(state: &AppState) -> Result<InjectorMetadata, String> {
    let fallback = || InjectorMetadata {
        version: state.injector_version.clone(),
        sha256: state.injector_sha256.clone(),
        download_url: None,
    };
    let remote = match state.http.get(&state.injector_metadata_url).send().await {
        Ok(response) if response.status().is_success() => response,
        Ok(_) | Err(_) => return Ok(fallback()),
    };
    let mut metadata = match remote.json::<InjectorMetadata>().await {
        Ok(metadata) => metadata,
        Err(_) => return Ok(fallback()),
    };
    if metadata.version.trim().is_empty() {
        return Ok(fallback());
    }
    metadata.sha256 = metadata
        .sha256
        .map(|value| value.trim().to_ascii_lowercase())
        .filter(|value| !value.is_empty());
    metadata.download_url = None;
    Ok(metadata)
}

/// `GET /authlib-injector/latest.json` — версия и checksum последнего injector.
async fn authlib_injector_metadata(
    State(state): State<Shared>,
) -> Result<Json<InjectorMetadata>, ApiError> {
    let mut metadata = resolve_injector_metadata(&state)
        .await
        .map_err(|e| ApiError::new(StatusCode::BAD_GATEWAY, e))?;
    metadata.download_url = Some("/authlib-injector.jar".into());
    Ok(Json(metadata))
}

/// `GET /authlib-injector.jar` — отдаёт последнюю StarDust-сборку.
///
/// Публичный endpoint сохраняется для старых лаунчеров и админки. Кэш
/// инвалидируется при смене версии или checksum в release metadata.
async fn authlib_injector(State(state): State<Shared>) -> Result<Response, ApiError> {
    let metadata = resolve_injector_metadata(&state)
        .await
        .map_err(|e| ApiError::new(StatusCode::BAD_GATEWAY, e))?;
    let mut guard = state.injector.lock().await;

    let fresh = guard
        .as_ref()
        .map(|c| {
            c.fetched.elapsed() < INJECTOR_TTL
                && c.version == metadata.version
                && c.sha256 == metadata.sha256
        })
        .unwrap_or(false);

    if !fresh {
        match fetch_injector(&state.http, &state.injector_url, metadata.sha256.as_deref()).await {
            Ok(bytes) => {
                *guard = Some(InjectorCache {
                    bytes,
                    version: metadata.version.clone(),
                    sha256: metadata.sha256.clone(),
                    fetched: Instant::now(),
                });
            }
            Err(e) => {
                if guard.is_none() {
                    return Err(ApiError::new(
                        StatusCode::BAD_GATEWAY,
                        format!("Не удалось получить authlib-injector: {e}"),
                    ));
                }
                tracing::warn!("обновление authlib-injector не удалось, отдаю кэш: {e}");
            }
        }
    }

    let cached = guard.as_ref().expect("кэш инжектора должен быть заполнен");
    let bytes = cached.bytes.clone();
    let version = cached.version.clone();

    Ok((
        StatusCode::OK,
        [
            (header::CONTENT_TYPE, "application/java-archive"),
            (header::CACHE_CONTROL, "public, max-age=3600"),
            (
                header::HeaderName::from_static("x-authlib-injector-version"),
                version.as_str(),
            ),
            (
                header::CONTENT_DISPOSITION,
                "attachment; filename=\"authlib-injector.jar\"",
            ),
        ],
        bytes,
    )
        .into_response())
}

/// Скачивает StarDust authlib-injector и сверяет SHA-256. Апстрим намеренно
/// не используется: его `ProfileKeyFilter` возвращает фиктивную подпись `AA==`.
async fn fetch_injector(
    http: &reqwest::Client,
    url: &str,
    expected_sha256: Option<&str>,
) -> Result<Vec<u8>, String> {
    let bytes = http
        .get(url)
        .send()
        .await
        .map_err(|e| format!("загрузка StarDust authlib-injector: {e}"))?
        .error_for_status()
        .map_err(|e| format!("StarDust authlib-injector: {e}"))?
        .bytes()
        .await
        .map_err(|e| format!("чтение authlib-injector: {e}"))?
        .to_vec();

    if let Some(expected) = expected_sha256 {
        let actual = sha256_hex(&bytes);
        if actual != expected.trim().to_ascii_lowercase() {
            return Err(format!(
                "sha256 authlib-injector не совпадает (ожидали {expected}, получили {actual})"
            ));
        }
    }
    Ok(bytes)
}

// ───────────────────────── Хелперы ─────────────────────────

/// Проверяет bearer-токен, отсутствие бана и роль `admin`.
async fn require_admin(state: &Shared, headers: &HeaderMap) -> Result<store::Account, ApiError> {
    let token = bearer_token(headers)?;
    let uuid = state
        .store
        .validate_session(&token)
        .await
        .ok_or_else(|| ApiError::new(StatusCode::UNAUTHORIZED, "Сессия недействительна"))?;
    let account = state
        .store
        .find_by_uuid(&uuid)
        .await
        .ok_or_else(|| ApiError::new(StatusCode::UNAUTHORIZED, "Аккаунт не найден"))?;
    if account.is_banned() {
        return Err(ApiError::new(StatusCode::FORBIDDEN, "Аккаунт заблокирован"));
    }
    if !account.is_admin() {
        return Err(ApiError::new(StatusCode::FORBIDDEN, "Недостаточно прав"));
    }
    Ok(account)
}

/// Имя файла из GitHub asset: только basename, без `..` и разделителей пути.
fn sanitize_asset_filename(name: &str) -> Result<String, ApiError> {
    let base = std::path::Path::new(name)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("");
    if base.is_empty()
        || base.contains("..")
        || base.contains('/')
        || base.contains('\\')
        || !base.ends_with(".jar")
    {
        return Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            format!("небезопасное имя jar-ассета: {name}"),
        ));
    }
    Ok(base.to_string())
}

fn bearer_token(headers: &HeaderMap) -> Result<String, ApiError> {
    let value = headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .ok_or_else(|| ApiError::new(StatusCode::UNAUTHORIZED, "Нужна авторизация"))?;
    let token = value
        .strip_prefix("Bearer ")
        .ok_or_else(|| ApiError::new(StatusCode::UNAUTHORIZED, "Нужен Bearer-токен"))?
        .trim();
    if token.is_empty() {
        return Err(ApiError::new(StatusCode::UNAUTHORIZED, "Пустой токен"));
    }
    Ok(token.to_string())
}

fn sha1_hex(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut hasher = Sha1::new();
    hasher.update(bytes);
    let digest = hasher.finalize();
    let mut out = String::with_capacity(40);
    for &b in &digest {
        out.push(HEX[(b >> 4) as usize] as char);
        out.push(HEX[(b & 0x0f) as usize] as char);
    }
    out
}

fn sha256_hex(bytes: &[u8]) -> String {
    use sha2::{Digest as _, Sha256};
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    let digest = hasher.finalize();
    let mut out = String::with_capacity(64);
    for &b in &digest {
        out.push(HEX[(b >> 4) as usize] as char);
        out.push(HEX[(b & 0x0f) as usize] as char);
    }
    out
}

fn internal(e: impl std::fmt::Display) -> ApiError {
    // Полная причина — в журнал (админ его видит), наружу — заглушка:
    // сюда доезжают и sqlx-ошибки с деталями БД, и пути на сервере.
    tracing::error!("internal: {e}");
    ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, "Внутренняя ошибка сервера")
}

fn map_store(e: store::StoreError) -> ApiError {
    match e {
        store::StoreError::NotFound => ApiError::new(StatusCode::NOT_FOUND, "Не найдено"),
        store::StoreError::NameTaken => ApiError::new(StatusCode::CONFLICT, "Такой slug уже занят"),
        // sqlx-текст наружу не отдаём: в нём всплывают имя БД, схемы и
        // куски SQL (детали инфраструктуры для атакующего). Лог — да, ответ — нет.
        store::StoreError::Backend(msg) => {
            tracing::error!("ошибка хранилища: {msg}");
            ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, "Внутренняя ошибка сервера")
        }
        other => ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, other.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::{find_mod_jar, tag_is_release, GitHubAsset};

    fn asset(name: &str) -> GitHubAsset {
        GitHubAsset {
            id: None,
            name: name.to_string(),
            browser_download_url: format!("https://example.com/{name}"),
            updated_at: None,
        }
    }

    #[test]
    fn find_mod_jar_picks_neoforge_for_neoforge_build() {
        let assets = vec![
            asset("stardust-mod-0.5.0.jar"),
            asset("stardust-mod-0.5.0.jar.sha256"),
            asset("stardust-mod-fabric-0.5.0.jar"),
            asset("stardust-mod-fabric-0.5.0.jar.sha256"),
        ];
        let jar = find_mod_jar(&assets, false).expect("NeoForge jar");
        assert_eq!(jar.name, "stardust-mod-0.5.0.jar");
    }

    #[test]
    fn find_mod_jar_picks_fabric_for_fabric_build() {
        let assets = vec![
            asset("stardust-mod-0.5.0.jar"),
            asset("stardust-mod-fabric-0.5.0.jar"),
            asset("stardust-mod-fabric-0.5.0.jar.sha256"),
        ];
        let jar = find_mod_jar(&assets, true).expect("Fabric jar");
        assert_eq!(jar.name, "stardust-mod-fabric-0.5.0.jar");
    }

    #[test]
    fn find_mod_jar_skips_sources_and_sha() {
        let assets = vec![
            asset("stardust-mod-0.5.0-sources.jar"),
            asset("stardust-mod-0.5.0.jar.sha256"),
        ];
        assert!(find_mod_jar(&assets, false).is_none());
    }

    #[test]
    fn find_mod_jar_none_when_only_other_loader_present() {
        // Релиз до 0.5.0: только NeoForge-jar. Fabric-сборка не должна
        // молча получить NeoForge-артефакт.
        let assets = vec![asset("stardust-mod-0.4.9.jar")];
        assert!(find_mod_jar(&assets, true).is_none());
    }

    #[test]
    fn tag_is_release_accepts_plain_and_fix_tags() {
        assert!(tag_is_release("v0.11.19"));
        assert!(tag_is_release("v1.0.0"));
        // Fix-релизы поверх базовой версии.
        assert!(tag_is_release("v0.11.19-fix1"));
        assert!(tag_is_release("v0.11.19-fix10"));
    }

    #[test]
    fn tag_is_release_rejects_garbage() {
        assert!(!tag_is_release("0.11.19"));
        assert!(!tag_is_release("v1.2"));
        assert!(!tag_is_release("v1.2.3.4"));
        assert!(!tag_is_release(""));
        assert!(!tag_is_release("v"));
        // dot-segment и слэши — увод path URL на GitHub.
        assert!(!tag_is_release("v1.2.3/../etc"));
        assert!(!tag_is_release("vx.y.z"));
        // Битые суффиксы -fix.
        assert!(!tag_is_release("v1.2.3-fix"));
        assert!(!tag_is_release("v1.2.3-fixx"));
        assert!(!tag_is_release("v1.2.3-fix1x"));
        assert!(!tag_is_release("v1.2.3-fix-1"));
    }
}
