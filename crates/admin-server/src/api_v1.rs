//! Программный API v1: загрузка модов в сборку и управление API-токенами.
//!
//! Отдельный namespace `/api/v1` для машинных клиентов (скрипты, CI,
//! MCP-агенты). Авторизация — собственные API-токены (`sd_…`), не пароль
//! админа и не игровой server-token: см. `store::api_token`. Управление
//! токенами идёт через обычную админ-сессию (`require_admin`), потому что
//! первый токен неоткуда взять иначе.
//!
//! Загрузка принимает тот же multipart, что и UI (`meta` + `file`), но
//! строже проверяет содержимое: JAR обязан быть zip-архивом с метаданными
//! выбранного загрузчика (`neoforge.mods.toml`/`mods.toml` или
//! `fabric.mod.json`) и `modId`. Повторная загрузка того же содержимого
//! идемпотентна: возвращается существующая запись с `duplicate: true`.
//!
//! Все ответы — стабильные JSON-схемы в camelCase; ошибки — `{"error": …,
//! "code": …}`, где `code` не зависит от локали. Описание для MCP-клиентов:
//! `docs/api-mod-upload.md`.

use std::io::Read;
use std::net::SocketAddr;
use std::path::{Path as FsPath, PathBuf};

use axum::{
    extract::{ConnectInfo, DefaultBodyLimit, Multipart, Path, State},
    http::{HeaderMap, StatusCode},
    Json,
};
use futures_util::TryStreamExt;
use serde::{Deserialize, Serialize};
use store::{ApiAuditEntry, ApiTokenRow};
use time::OffsetDateTime;

use crate::{
    bearer_token, get_client_ip, internal, map_store, require_admin, sha1_and_size_of_file,
    validate_rel_path, ApiError, Shared,
};

/// Лимит тела загрузки мода. Моды редко бывают больше 100 МБ; 256 МБ —
/// щедрый запас и вчетверо меньше общего UI-лимита (512 МБ).
pub(crate) const MAX_API_MOD_BYTES: usize = 256 * 1024 * 1024;

/// Лимит на чтение метаданных из jar: защита от «zip bomb» с гигантским
/// `mods.toml`, который распаковался бы в память.
const MAX_METADATA_BYTES: u64 = 1024 * 1024;

/// Частота загрузок: 30 запросов в минуту на IP. Пакетная загрузка
/// 30 модов в минуту — реалистичный потолок для агента. Одна проверка на
/// запрос: `check_rate_limit` хранит метки на IP в общем списке, и двойной
/// вызов расходовал бы квоту вдвое быстрее.
const UPLOAD_RATE_MAX: usize = 30;
const UPLOAD_RATE_WINDOW_SECS: u64 = 60;

const MAX_TOKEN_NAME_CHARS: usize = 64;
const MAX_TOKEN_LIFETIME_DAYS: u32 = 3650;

// ───────────────────────── Авторизация ─────────────────────────

/// Результат проверки API-токена.
struct ApiAuth {
    token_id: i64,
    account: store::Account,
}

fn unauthorized(code: &str, message: impl Into<String>) -> ApiError {
    ApiError::with_code(StatusCode::UNAUTHORIZED, code, message)
}

fn forbidden(code: &str, message: impl Into<String>) -> ApiError {
    ApiError::with_code(StatusCode::FORBIDDEN, code, message)
}

/// Проверяет `Authorization: Bearer sd_…`. Отдельный код на каждую причину:
/// MCP-клиенту важно отличать «нет токена» от «токен отозван/неверен».
async fn require_api_token(state: &Shared, headers: &HeaderMap) -> Result<ApiAuth, ApiError> {
    let token = bearer_token(headers).map_err(|_| {
        unauthorized(
            "missing_token",
            "Нужен заголовок Authorization: Bearer <API-токен>",
        )
    })?;
    if !token.starts_with(store::API_TOKEN_PREFIX) {
        // Сессионный токен админки здесь не принимается: у него другой
        // жизненный цикл и обязательный 2FA при выдаче.
        return Err(unauthorized(
            "invalid_token",
            "Неверный API-токен (ожидается токен с префиксом sd_)",
        ));
    }
    let owner = state
        .store
        .validate_api_token(&token)
        .await
        .ok_or_else(|| {
            unauthorized(
                "invalid_token",
                "API-токен недействителен, отозван или истёк",
            )
        })?;
    let account = state
        .store
        .find_by_uuid(&owner.account_uuid)
        .await
        .ok_or_else(|| unauthorized("invalid_token", "Владелец токена не найден"))?;
    if account.is_banned() {
        return Err(forbidden("account_banned", "Аккаунт заблокирован"));
    }
    if !account.is_admin() {
        return Err(forbidden("not_admin", "Токен принадлежит не админу"));
    }
    Ok(ApiAuth {
        token_id: owner.token_id,
        account,
    })
}

/// Общий IP-лимит для машинных эндпоинтов.
fn check_ip_rate(
    state: &Shared,
    headers: &HeaderMap,
    addr: SocketAddr,
    max: usize,
    window_secs: u64,
) -> Result<(), ApiError> {
    let ip = get_client_ip(headers, addr);
    if state.store.check_rate_limit(ip, max, window_secs) {
        return Err(ApiError::with_code(
            StatusCode::TOO_MANY_REQUESTS,
            "rate_limited",
            "Слишком много запросов, попробуйте позже",
        ));
    }
    Ok(())
}

/// Пишет аудит и не валит запрос при сбое записи: операция уже выполнена,
/// а ошибка аудита должна быть видна в логах, но не превращаться в 500.
async fn audit(state: &Shared, auth: &ApiAuth, entry: ApiAuditEntry) {
    let entry = ApiAuditEntry {
        token_id: Some(auth.token_id),
        account_uuid: auth.account.uuid.clone(),
        ..entry
    };
    if let Err(e) = state.store.record_api_audit(&entry).await {
        tracing::warn!(
            token_id = auth.token_id,
            account = %auth.account.username,
            "api-v1: не удалось записать аудит: {e}"
        );
    }
}

// ───────────────────────── Управление токенами ─────────────────────────

#[derive(Deserialize)]
struct CreateTokenRequest {
    name: String,
    /// Срок жизни в днях. Не задан — бессрочный (до отзыва).
    #[serde(rename = "expiresInDays", default)]
    expires_in_days: Option<u32>,
}

#[derive(Serialize)]
struct TokenDto {
    id: i64,
    #[serde(rename = "accountUuid")]
    account_uuid: String,
    username: String,
    name: String,
    #[serde(rename = "tokenPrefix")]
    token_prefix: String,
    #[serde(rename = "createdAt")]
    created_at: String,
    #[serde(rename = "lastUsedAt")]
    last_used_at: Option<String>,
    #[serde(rename = "revokedAt")]
    revoked_at: Option<String>,
    #[serde(rename = "expiresAt")]
    expires_at: Option<String>,
    /// Можно ли пользоваться токеном прямо сейчас.
    active: bool,
}

impl TokenDto {
    fn from_row(row: ApiTokenRow) -> Self {
        let active = row.revoked_at.is_none()
            && row
                .expires_at
                .as_deref()
                .and_then(parse_rfc3339)
                .map(|expires| expires > OffsetDateTime::now_utc())
                .unwrap_or(true);
        Self {
            id: row.id,
            account_uuid: row.account_uuid,
            username: row.username,
            name: row.name,
            token_prefix: row.token_prefix,
            created_at: row.created_at,
            last_used_at: row.last_used_at,
            revoked_at: row.revoked_at,
            expires_at: row.expires_at,
            active,
        }
    }
}

fn parse_rfc3339(raw: &str) -> Option<OffsetDateTime> {
    OffsetDateTime::parse(raw, &time::format_description::well_known::Rfc3339).ok()
}

#[derive(Serialize)]
struct CreatedTokenResponse {
    /// Полный токен. Показывается только в этом ответе и нигде не хранится
    /// в открытом виде.
    token: String,
    #[serde(rename = "tokenInfo")]
    token_info: TokenDto,
}

/// `POST /api/api-tokens` — создать API-токен (под админ-сессией).
async fn create_token(
    State(state): State<Shared>,
    headers: HeaderMap,
    Json(req): Json<CreateTokenRequest>,
) -> Result<(StatusCode, Json<CreatedTokenResponse>), ApiError> {
    let admin = require_admin(&state, &headers).await?;
    let name = req.name.trim();
    if name.is_empty() || name.chars().count() > MAX_TOKEN_NAME_CHARS {
        return Err(ApiError::with_code(
            StatusCode::BAD_REQUEST,
            "invalid_token_name",
            format!("Имя токена: 1–{MAX_TOKEN_NAME_CHARS} символов"),
        ));
    }
    let expires_at = match req.expires_in_days {
        Some(days) if days == 0 || days > MAX_TOKEN_LIFETIME_DAYS => {
            return Err(ApiError::with_code(
                StatusCode::BAD_REQUEST,
                "invalid_expiry",
                format!("expiresInDays: 1–{MAX_TOKEN_LIFETIME_DAYS}"),
            ));
        }
        Some(days) => Some(OffsetDateTime::now_utc() + time::Duration::days(days as i64)),
        None => None,
    };

    let (token, row) = state
        .store
        .create_api_token(&admin.uuid, name, expires_at)
        .await
        .map_err(map_store)?;
    tracing::info!(
        token_id = row.id,
        account = %admin.username,
        name = %row.name,
        "api-token: создан"
    );
    audit(
        &state,
        &ApiAuth {
            token_id: row.id,
            account: admin,
        },
        ApiAuditEntry {
            detail: Some(format!("name={}", row.name)),
            ..ApiAuditEntry::action("create_token")
        },
    )
    .await;

    Ok((
        StatusCode::CREATED,
        Json(CreatedTokenResponse {
            token,
            token_info: TokenDto::from_row(row),
        }),
    ))
}

#[derive(Serialize)]
struct TokenListResponse {
    tokens: Vec<TokenDto>,
}

/// `GET /api/api-tokens` — список токенов (без секретов).
async fn list_tokens(
    State(state): State<Shared>,
    headers: HeaderMap,
) -> Result<Json<TokenListResponse>, ApiError> {
    require_admin(&state, &headers).await?;
    let tokens = state.store.list_api_tokens().await.map_err(map_store)?;
    Ok(Json(TokenListResponse {
        tokens: tokens.into_iter().map(TokenDto::from_row).collect(),
    }))
}

/// `DELETE /api/api-tokens/:id` — отозвать токен (идемпотентно).
async fn revoke_token(
    State(state): State<Shared>,
    headers: HeaderMap,
    Path(id): Path<i64>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let admin = require_admin(&state, &headers).await?;
    state
        .store
        .revoke_api_token(id)
        .await
        .map_err(|e| match e {
            store::StoreError::NotFound => {
                ApiError::with_code(StatusCode::NOT_FOUND, "token_not_found", "Токен не найден")
            }
            other => map_store(other),
        })?;
    tracing::info!(token_id = id, account = %admin.username, "api-token: отозван");
    audit(
        &state,
        &ApiAuth {
            token_id: id,
            account: admin,
        },
        ApiAuditEntry::action("revoke_token"),
    )
    .await;
    Ok(Json(serde_json::json!({ "ok": true })))
}

// ───────────────────────── Загрузка модов ─────────────────────────

#[derive(Deserialize, Default)]
struct UploadMeta {
    /// Явный путь в сборке. Не задан — `mods/<имя файла из multipart>`.
    #[serde(default)]
    path: Option<String>,
    #[serde(default)]
    side: Option<String>,
    #[serde(default, rename = "modId")]
    mod_id: Option<String>,
    #[serde(default, rename = "displayName")]
    display_name: Option<String>,
    #[serde(default)]
    description: Option<String>,
    #[serde(default)]
    optional: Option<bool>,
    #[serde(default, rename = "enabledByDefault")]
    enabled_by_default: Option<bool>,
    #[serde(default)]
    overwrite: Option<bool>,
    #[serde(default)]
    profiles: Option<Vec<String>>,
}

#[derive(Serialize)]
struct ModUploadResponse {
    #[serde(rename = "fileId")]
    file_id: i64,
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
    profiles: Vec<String>,
    /// Загрузчик, метаданные которого найдены в JAR.
    loader: String,
    /// Версия мода из метаданных (если распознана).
    #[serde(rename = "modVersion")]
    mod_version: Option<String>,
    /// true — запись создана этим запросом; false — уже существовала.
    created: bool,
    /// true — содержимое уже было в сборке; вернули существующий файл.
    duplicate: bool,
    /// Сколько старых файлов с тем же modId удалено (замена версии).
    #[serde(rename = "removedOldVersions")]
    removed_old_versions: u64,
}

impl ModUploadResponse {
    fn from_row(
        row: &store::BuildFileRow,
        loader: &str,
        mod_version: Option<String>,
        created: bool,
        duplicate: bool,
        removed_old_versions: u64,
    ) -> Self {
        Self {
            file_id: row.id,
            path: row.path.clone(),
            sha1: row.sha1.clone(),
            size_bytes: row.size_bytes,
            side: row.side.clone(),
            kind: row.kind.clone(),
            overwrite: row.overwrite,
            optional: row.optional,
            enabled_by_default: row.enabled_by_default,
            disabled: row.disabled,
            mod_id: row.mod_id.clone(),
            display_name: row.display_name.clone(),
            description: row.description.clone(),
            profiles: row.profile_keys.clone(),
            loader: loader.to_string(),
            mod_version,
            created,
            duplicate,
            removed_old_versions,
        }
    }
}

/// Что делать с загруженным файлом. Вынесено в чистую функцию, чтобы
/// идемпотентность (дубликат по sha1 важнее совпадения пути) была
/// покрыта тестом без БД.
#[derive(Debug, PartialEq, Eq)]
enum UploadAction {
    /// То же содержимое уже есть в сборке — вернуть существующую запись.
    Duplicate,
    /// По этому пути лежит другой файл — заменить (как UI).
    Replace,
    /// Новый файл.
    Insert,
}

fn decide_upload_action(same_sha1_exists: bool, path_occupied: bool) -> UploadAction {
    if same_sha1_exists {
        UploadAction::Duplicate
    } else if path_occupied {
        UploadAction::Replace
    } else {
        UploadAction::Insert
    }
}

/// `POST /api/v1/builds/:id/mods` — загрузить мод в сборку.
///
/// Тело — multipart: поле `meta` (JSON, необязательно) и `file` (JAR).
/// Ответ 201 при создании, 200 при дубликате.
async fn upload_mod(
    State(state): State<Shared>,
    headers: HeaderMap,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    Path(build_id): Path<i64>,
    mut multipart: Multipart,
) -> Result<(StatusCode, Json<ModUploadResponse>), ApiError> {
    // Лимит до авторизации: незалогиненный флуд не должен доходить до БД.
    // Одна проверка на запрос — эндпоинт и так машинный.
    check_ip_rate(
        &state,
        &headers,
        addr,
        UPLOAD_RATE_MAX,
        UPLOAD_RATE_WINDOW_SECS,
    )?;
    let auth = require_api_token(&state, &headers).await?;

    let record = state
        .store
        .get_build(build_id)
        .await
        .map_err(internal)?
        .ok_or_else(|| {
            ApiError::with_code(
                StatusCode::NOT_FOUND,
                "build_not_found",
                "Сборка не найдена",
            )
        })?;
    if record.header.loader_kind == "vanilla" {
        return Err(ApiError::with_code(
            StatusCode::BAD_REQUEST,
            "loader_does_not_support_mods",
            "Сборка на vanilla не поддерживает моды",
        ));
    }

    let mut meta = UploadMeta::default();
    let mut temp_path: Option<PathBuf> = None;
    let mut upload_name: Option<String> = None;

    while let Some(field) = multipart.next_field().await.map_err(|e| {
        ApiError::with_code(
            StatusCode::BAD_REQUEST,
            "invalid_multipart",
            format!("multipart: {e}"),
        )
    })? {
        match field.name() {
            Some("meta") => {
                let text = field.text().await.map_err(|e| {
                    ApiError::with_code(
                        StatusCode::BAD_REQUEST,
                        "invalid_meta",
                        format!("meta: {e}"),
                    )
                })?;
                meta = serde_json::from_str(&text).map_err(|e| {
                    ApiError::with_code(
                        StatusCode::BAD_REQUEST,
                        "invalid_meta",
                        format!("meta JSON: {e}"),
                    )
                })?;
            }
            Some("file") => {
                if temp_path.is_some() {
                    return Err(ApiError::with_code(
                        StatusCode::BAD_REQUEST,
                        "too_many_files",
                        "За один запрос — один JAR",
                    ));
                }
                upload_name = field.file_name().map(str::to_string);
                let tp = tempfile::NamedTempFile::new_in(&state.modpack_dir)
                    .map_err(|e| internal(format!("temp file: {e}")))?;
                let mut file = tokio::fs::File::create(tp.path())
                    .await
                    .map_err(|e| internal(format!("create temp: {e}")))?;
                let mut stream = field.into_stream();
                use tokio::io::AsyncWriteExt;
                let mut total: u64 = 0;
                while let Some(chunk) = stream.try_next().await.map_err(|e| {
                    ApiError::with_code(
                        StatusCode::BAD_REQUEST,
                        "invalid_multipart",
                        format!("file chunk: {e}"),
                    )
                })? {
                    total += chunk.len() as u64;
                    if total > MAX_API_MOD_BYTES as u64 {
                        drop(file);
                        tokio::fs::remove_file(tp.path()).await.ok();
                        return Err(ApiError::with_code(
                            StatusCode::PAYLOAD_TOO_LARGE,
                            "payload_too_large",
                            format!("JAR больше {} МиБ", MAX_API_MOD_BYTES / (1024 * 1024)),
                        ));
                    }
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

    let temp_path = temp_path.ok_or_else(|| {
        ApiError::with_code(StatusCode::BAD_REQUEST, "missing_file", "Нет поля file")
    })?;

    // Ошибки после получения temp обязаны его убрать, иначе мусор копится
    // в каталоге хранилища.
    let cleanup = |path: &PathBuf| {
        let path = path.clone();
        async move {
            tokio::fs::remove_file(path).await.ok();
        }
    };

    let target_path = match resolve_target_path(meta.path.as_deref(), upload_name.as_deref()) {
        Ok(p) => p,
        Err(e) => {
            cleanup(&temp_path).await;
            return Err(e);
        }
    };
    let side = match meta.side.as_deref() {
        None | Some("both") => "both",
        Some("client") => "client",
        Some("server") => "server",
        Some(other) => {
            cleanup(&temp_path).await;
            return Err(ApiError::with_code(
                StatusCode::BAD_REQUEST,
                "invalid_side",
                format!("side: client|server|both (получено «{other}»)"),
            ));
        }
    };

    // Хеш и разбор JAR — блокирующие операции с диском и CPU.
    let (sha1, size_bytes) = match tokio::task::spawn_blocking({
        let path = temp_path.clone();
        move || sha1_and_size_of_file(&path)
    })
    .await
    {
        Ok(Ok(v)) => v,
        Ok(Err(e)) => {
            cleanup(&temp_path).await;
            return Err(internal(format!("hash temp: {e}")));
        }
        Err(e) => {
            cleanup(&temp_path).await;
            return Err(internal(format!("join: {e}")));
        }
    };

    let loader_kind = record.header.loader_kind.clone();
    let jar_meta = match tokio::task::spawn_blocking({
        let path = temp_path.clone();
        let loader = loader_kind.clone();
        move || inspect_mod_jar(&path, &loader).map(|meta| fill_manifest_version(&path, meta))
    })
    .await
    {
        Ok(Ok(meta)) => meta,
        Ok(Err(e)) => {
            cleanup(&temp_path).await;
            tracing::warn!(
                token_id = auth.token_id,
                account = %auth.account.username,
                build_id,
                "api-v1: отклонён JAR: {e:?}"
            );
            return Err(e.into_api_error());
        }
        Err(e) => {
            cleanup(&temp_path).await;
            return Err(internal(format!("join jar inspect: {e}")));
        }
    };

    // Идемпотентность: то же содержимое уже в сборке — возвращаем как есть.
    // Проверяем до записи блоба, чтобы повторный запрос ничего не менял.
    let same_sha1 = state
        .store
        .find_build_file_by_sha1(build_id, &sha1)
        .await
        .map_err(map_store)?;
    let path_row = state
        .store
        .find_build_file_by_path(build_id, &target_path)
        .await
        .map_err(map_store)?;
    let replaced = path_row.is_some() && same_sha1.is_none();
    match decide_upload_action(same_sha1.is_some(), path_row.is_some()) {
        UploadAction::Duplicate => {
            cleanup(&temp_path).await;
            let existing = same_sha1.expect("duplicate подразумевает строку");
            audit(
                &state,
                &auth,
                ApiAuditEntry {
                    build_id: Some(build_id),
                    file_id: Some(existing.id),
                    sha1: Some(existing.sha1.clone()),
                    path: Some(existing.path.clone()),
                    detail: Some(format!(
                        "loader={} modId={}",
                        jar_meta.loader, jar_meta.mod_id
                    )),
                    ..ApiAuditEntry::action("upload_mod_duplicate")
                },
            )
            .await;
            tracing::info!(
                token_id = auth.token_id,
                account = %auth.account.username,
                build_id,
                file_id = existing.id,
                sha1 = %existing.sha1,
                "api-v1: дубликат мода, возвращаю существующий"
            );
            return Ok((
                StatusCode::OK,
                Json(ModUploadResponse::from_row(
                    &existing,
                    &jar_meta.loader,
                    jar_meta.version.clone(),
                    false,
                    true,
                    0,
                )),
            ));
        }
        UploadAction::Replace | UploadAction::Insert => {}
    }

    // Байты — в контент-адресное хранилище.
    let dest = state.modpack_dir.join(&sha1);
    if dest.exists() {
        cleanup(&temp_path).await;
    } else if let Err(e) = tokio::fs::rename(&temp_path, &dest).await {
        cleanup(&temp_path).await;
        return Err(internal(format!("rename temp: {e}")));
    }

    let profile_keys = meta.profiles.take().unwrap_or_default();
    // modId: явный из meta важнее распознанного; нужен и для записи, и для
    // удаления старых версий — вычисляем до перемещения полей.
    let effective_mod_id = file_input_mod_id(&meta, &jar_meta);
    let file_input = store::BuildFileInput {
        path: target_path.clone(),
        sha1: sha1.clone(),
        size_bytes,
        side: side.to_string(),
        kind: "mod".to_string(),
        overwrite: meta.overwrite.unwrap_or(true),
        optional: meta.optional.unwrap_or(false),
        enabled_by_default: meta.enabled_by_default.unwrap_or(true),
        disabled: false,
        mod_id: effective_mod_id.clone(),
        display_name: meta
            .display_name
            .take()
            .filter(|s| !s.trim().is_empty())
            .or_else(|| jar_meta.name.clone()),
        description: meta
            .description
            .take()
            .filter(|s| !s.trim().is_empty())
            .or_else(|| jar_meta.description.clone()),
        storage_key: sha1.clone(),
        profile_keys,
    };

    let (file_id, _) = state
        .store
        .upsert_build_file(build_id, file_input)
        .await
        .map_err(map_store)?;

    // Новая версия мода обычно приходит под новым именем файла: убираем
    // прочие файлы с тем же modId, иначе загрузчик увидит две версии.
    let mut removed = 0u64;
    if let Some(mod_id) = effective_mod_id {
        removed = state
            .store
            .delete_other_build_files_by_mod_id(build_id, &mod_id, &target_path)
            .await
            .map_err(map_store)?;
    }

    // Перечитываем строку, чтобы отдать точные метаданные (в т.ч. после
    // удаления старых версий и upsert).
    let row = state.store.build_file(file_id).await.map_err(map_store)?;

    audit(
        &state,
        &auth,
        ApiAuditEntry {
            build_id: Some(build_id),
            file_id: Some(file_id),
            sha1: Some(sha1.clone()),
            path: Some(target_path.clone()),
            detail: Some(format!(
                "loader={} modId={} version={} replaced={replaced} removed={removed}",
                jar_meta.loader,
                jar_meta.mod_id,
                jar_meta.version.as_deref().unwrap_or("-")
            )),
            ..ApiAuditEntry::action("upload_mod")
        },
    )
    .await;
    tracing::info!(
        token_id = auth.token_id,
        account = %auth.account.username,
        build_id,
        file_id,
        path = %target_path,
        sha1 = %sha1,
        size = size_bytes,
        "api-v1: мод загружен"
    );

    Ok((
        StatusCode::CREATED,
        Json(ModUploadResponse::from_row(
            &row,
            &jar_meta.loader,
            jar_meta.version.clone(),
            !replaced,
            false,
            removed,
        )),
    ))
}

/// modId, который реально попал в БД (override из meta важнее метаданных).
fn file_input_mod_id(meta: &UploadMeta, jar: &JarModMeta) -> Option<String> {
    meta.mod_id
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .or_else(|| Some(jar.mod_id.clone()))
}

/// Проверяет имя файла: только basename, без разделителей и `..`.
fn sanitize_mod_filename(raw: &str) -> Result<String, ApiError> {
    let name = raw.trim();
    let invalid = |msg: &str| {
        ApiError::with_code(
            StatusCode::BAD_REQUEST,
            "invalid_filename",
            format!("Имя файла недопустимо: {msg}"),
        )
    };
    if name.is_empty() {
        return Err(invalid("пусто"));
    }
    if name.contains('/') || name.contains('\\') {
        return Err(invalid("путь запрещён, передайте только имя файла"));
    }
    if name.contains("..") || name == "." || name == ".." {
        return Err(invalid("выход за пределы каталога запрещён"));
    }
    if name.chars().any(|c| c.is_control() || c == '\0') {
        return Err(invalid("управляющие символы запрещены"));
    }
    if name.chars().count() > 200 {
        return Err(invalid("слишком длинное имя"));
    }
    if !name.to_ascii_lowercase().ends_with(".jar") {
        return Err(invalid("ожидается .jar"));
    }
    // Разрешаем только безопасный набор: буквы, цифры, `. _ + -`.
    if !name
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '+' | '-'))
    {
        return Err(invalid("разрешены только ASCII-буквы, цифры и . _ + -"));
    }
    Ok(name.to_string())
}

/// Определяет путь файла в сборке. Явный `meta.path` проверяется на
/// traversal и обязан лежать в `mods/`; иначе путь строится из имени файла.
fn resolve_target_path(
    meta_path: Option<&str>,
    upload_name: Option<&str>,
) -> Result<String, ApiError> {
    if let Some(raw) = meta_path {
        let path = raw.trim();
        if path.is_empty() {
            return Err(ApiError::with_code(
                StatusCode::BAD_REQUEST,
                "invalid_path",
                "Пустой path",
            ));
        }
        validate_rel_path(path)
            .map_err(|e| ApiError::with_code(StatusCode::BAD_REQUEST, "invalid_path", e.message))?;
        if path.contains('\\') {
            return Err(ApiError::with_code(
                StatusCode::BAD_REQUEST,
                "invalid_path",
                "Обратные слэши в пути запрещены",
            ));
        }
        if path.chars().any(char::is_control) {
            return Err(ApiError::with_code(
                StatusCode::BAD_REQUEST,
                "invalid_path",
                "Управляющие символы в пути запрещены",
            ));
        }
        if !path.to_ascii_lowercase().ends_with(".jar") {
            return Err(ApiError::with_code(
                StatusCode::BAD_REQUEST,
                "invalid_path",
                "Путь мода должен оканчиваться на .jar",
            ));
        }
        let under_mods = path
            .split('/')
            .next()
            .map(|first| first.eq_ignore_ascii_case("mods"))
            .unwrap_or(false);
        if !under_mods || path.split('/').count() < 2 {
            return Err(ApiError::with_code(
                StatusCode::BAD_REQUEST,
                "invalid_path",
                "Мод должен лежать в mods/<файл>.jar",
            ));
        }
        return Ok(path.to_string());
    }

    let name = upload_name.ok_or_else(|| {
        ApiError::with_code(
            StatusCode::BAD_REQUEST,
            "missing_filename",
            "Не удалось определить имя файла — передайте meta.path или имя в multipart",
        )
    })?;
    let name = sanitize_mod_filename(name)?;
    Ok(format!("mods/{name}"))
}

// ───────────────────────── Разбор JAR ─────────────────────────

/// Метаданные мода, вытащенные из JAR.
#[derive(Debug, Clone)]
struct JarModMeta {
    /// Человекочитаемое имя загрузчика (`neoforge`/`forge`/`fabric`/`quilt`).
    loader: String,
    mod_id: String,
    version: Option<String>,
    name: Option<String>,
    description: Option<String>,
}

/// Почему JAR не принят. Каждая причина — свой стабильный код ошибки.
#[derive(Debug, Clone, PartialEq, Eq)]
enum JarError {
    NotZip(String),
    MissingMetadata,
    WrongLoader(String),
    InvalidMetadata(String),
    MissingModId,
}

impl JarError {
    fn into_api_error(self) -> ApiError {
        let (code, message) = match self {
            JarError::NotZip(detail) => (
                "invalid_jar",
                format!("Файл не является корректным JAR/zip: {detail}"),
            ),
            JarError::MissingMetadata => (
                "missing_mod_metadata",
                "В JAR нет метаданных мода (neoforge.mods.toml, mods.toml или fabric.mod.json)"
                    .to_string(),
            ),
            JarError::WrongLoader(found) => (
                "wrong_loader",
                format!("JAR содержит метаданные «{found}», а сборка собрана на другом загрузчике"),
            ),
            JarError::InvalidMetadata(detail) => (
                "invalid_mod_metadata",
                format!("Не удалось разобрать метаданные мода: {detail}"),
            ),
            JarError::MissingModId => (
                "missing_mod_id",
                "В метаданных мода не найден modId".to_string(),
            ),
        };
        ApiError::with_code(StatusCode::BAD_REQUEST, code, message)
    }
}

/// Проверяет, что файл — zip/JAR, и достаёт `modId`/версию/имя/описание для
/// загрузчика сборки. Чтение метаданных ограничено по размеру.
fn inspect_mod_jar(path: &FsPath, loader_kind: &str) -> Result<JarModMeta, JarError> {
    let file = std::fs::File::open(path)
        .map_err(|e| JarError::NotZip(format!("не удалось открыть: {e}")))?;
    let mut zip = zip::ZipArchive::new(file).map_err(|e| JarError::NotZip(format!("zip: {e}")))?;

    let wants_toml = matches!(loader_kind, "neoforge" | "forge");
    let wants_fabric = matches!(loader_kind, "fabric" | "quilt");

    let toml_text = read_zip_text(
        &mut zip,
        &["META-INF/neoforge.mods.toml", "META-INF/mods.toml"],
    )?;
    let fabric_text = read_zip_text(&mut zip, &["fabric.mod.json"])?;

    if wants_toml {
        if let Some(text) = toml_text {
            return parse_mods_toml(&text, loader_kind);
        }
        if fabric_text.is_some() {
            return Err(JarError::WrongLoader("fabric".to_string()));
        }
        return Err(JarError::MissingMetadata);
    }
    if wants_fabric {
        if let Some(text) = fabric_text {
            return parse_fabric_mod_json(&text, loader_kind);
        }
        if toml_text.is_some() {
            return Err(JarError::WrongLoader("neoforge/forge".to_string()));
        }
        return Err(JarError::MissingMetadata);
    }
    Err(JarError::InvalidMetadata(format!(
        "неизвестный загрузчик сборки: {loader_kind}"
    )))
}

/// Читает первый существующий текстовый файл из zip с потолком размера.
fn read_zip_text(
    zip: &mut zip::ZipArchive<std::fs::File>,
    names: &[&str],
) -> Result<Option<String>, JarError> {
    for name in names {
        let mut entry = match zip.by_name(name) {
            Ok(entry) => entry,
            Err(zip::result::ZipError::FileNotFound) => continue,
            Err(e) => return Err(JarError::NotZip(e.to_string())),
        };
        if entry.size() > MAX_METADATA_BYTES {
            return Err(JarError::InvalidMetadata(format!(
                "{name} больше {MAX_METADATA_BYTES} байт"
            )));
        }
        let mut buf = String::new();
        entry
            .read_to_string(&mut buf)
            .map_err(|e| JarError::InvalidMetadata(format!("{name}: {e}")))?;
        return Ok(Some(buf));
    }
    Ok(None)
}

/// Читает `Implementation-Version` из `META-INF/MANIFEST.MF` — запасной
/// источник версии, когда в TOML стоит плейсхолдер `${file.jarVersion}`.
fn manifest_version(zip: &mut zip::ZipArchive<std::fs::File>) -> Option<String> {
    let mut entry = zip.by_name("META-INF/MANIFEST.MF").ok()?;
    if entry.size() > MAX_METADATA_BYTES {
        return None;
    }
    let mut buf = String::new();
    entry.read_to_string(&mut buf).ok()?;
    buf.lines().find_map(|line| {
        let (key, value) = line.split_once(':')?;
        if key.trim().eq_ignore_ascii_case("Implementation-Version") {
            let value = value.trim();
            (!value.is_empty()).then(|| value.to_string())
        } else {
            None
        }
    })
}

fn clean_meta_string(value: Option<&toml::Value>) -> Option<String> {
    value
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

fn parse_mods_toml(raw: &str, loader_kind: &str) -> Result<JarModMeta, JarError> {
    let value: toml::Value =
        toml::from_str(raw).map_err(|e| JarError::InvalidMetadata(format!("TOML: {e}")))?;
    let mods = value
        .get("mods")
        .and_then(|v| v.as_array())
        .filter(|a| !a.is_empty())
        .ok_or(JarError::MissingModId)?;
    let first = &mods[0];
    let mod_id = first
        .get("modId")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or(JarError::MissingModId)?;
    let version = clean_meta_string(first.get("version")).filter(|v| !v.contains("${"));
    Ok(JarModMeta {
        loader: if loader_kind == "forge" {
            "forge"
        } else {
            "neoforge"
        }
        .to_string(),
        mod_id: mod_id.to_string(),
        version,
        name: clean_meta_string(first.get("displayName")),
        description: clean_meta_string(first.get("description")),
    })
}

#[derive(Deserialize)]
struct FabricModJson {
    id: String,
    #[serde(default)]
    version: Option<String>,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    description: Option<String>,
}

fn parse_fabric_mod_json(raw: &str, loader_kind: &str) -> Result<JarModMeta, JarError> {
    let parsed: FabricModJson = serde_json::from_str(raw)
        .map_err(|e| JarError::InvalidMetadata(format!("fabric.mod.json: {e}")))?;
    let mod_id = parsed.id.trim();
    if mod_id.is_empty() {
        return Err(JarError::MissingModId);
    }
    Ok(JarModMeta {
        loader: if loader_kind == "quilt" {
            "quilt"
        } else {
            "fabric"
        }
        .to_string(),
        mod_id: mod_id.to_string(),
        version: parsed
            .version
            .map(|v| v.trim().to_string())
            .filter(|v| !v.is_empty() && !v.contains("${")),
        name: parsed.name.filter(|s| !s.trim().is_empty()),
        description: parsed.description.filter(|s| !s.trim().is_empty()),
    })
}

/// Достаёт версию из манифеста, если в TOML был плейсхолдер.
fn fill_manifest_version(path: &FsPath, mut meta: JarModMeta) -> JarModMeta {
    if meta.version.is_none() {
        if let Ok(file) = std::fs::File::open(path) {
            if let Ok(mut zip) = zip::ZipArchive::new(file) {
                meta.version = manifest_version(&mut zip);
            }
        }
    }
    meta
}

// ───────────────────────── Роутер ─────────────────────────

pub(crate) fn routes() -> axum::Router<Shared> {
    use axum::routing::{delete, get, post};
    axum::Router::new()
        .route(
            "/api/v1/builds/:id/mods",
            post(upload_mod).layer(DefaultBodyLimit::max(MAX_API_MOD_BYTES)),
        )
        .route("/api/api-tokens", get(list_tokens).post(create_token))
        .route("/api/api-tokens/:id", delete(revoke_token))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use zip::write::SimpleFileOptions;

    fn write_jar(entries: &[(&str, &str)]) -> (tempfile::TempDir, PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("test.jar");
        let file = std::fs::File::create(&path).unwrap();
        let mut zip = zip::ZipWriter::new(file);
        let opts = SimpleFileOptions::default();
        for (name, content) in entries {
            zip.start_file(*name, opts).unwrap();
            zip.write_all(content.as_bytes()).unwrap();
        }
        zip.finish().unwrap();
        (dir, path)
    }

    const NEOFORGE_TOML: &str = r#"
modLoader = "javafml"
loaderVersion = "[1,)"

[[mods]]
modId = "sodium"
version = "0.6.13"
displayName = "Sodium"
description = "Fast renderer"
"#;

    #[test]
    fn neoform_jar_metadata_is_parsed() {
        let (_dir, path) = write_jar(&[("META-INF/neoforge.mods.toml", NEOFORGE_TOML)]);
        let meta = inspect_mod_jar(&path, "neoforge").unwrap();
        assert_eq!(meta.mod_id, "sodium");
        assert_eq!(meta.version.as_deref(), Some("0.6.13"));
        assert_eq!(meta.name.as_deref(), Some("Sodium"));
        assert_eq!(meta.description.as_deref(), Some("Fast renderer"));
        assert_eq!(meta.loader, "neoforge");
    }

    #[test]
    fn legacy_mods_toml_is_accepted_for_forge() {
        let (_dir, path) = write_jar(&[("META-INF/mods.toml", NEOFORGE_TOML)]);
        let meta = inspect_mod_jar(&path, "forge").unwrap();
        assert_eq!(meta.mod_id, "sodium");
        assert_eq!(meta.loader, "forge");
    }

    #[test]
    fn fabric_mod_json_is_parsed() {
        let json = r#"{"schemaVersion":1,"id":"lithium","version":"0.12.1","name":"Lithium"}"#;
        let (_dir, path) = write_jar(&[("fabric.mod.json", json)]);
        let meta = inspect_mod_jar(&path, "fabric").unwrap();
        assert_eq!(meta.mod_id, "lithium");
        assert_eq!(meta.version.as_deref(), Some("0.12.1"));
        assert_eq!(meta.loader, "fabric");
    }

    #[test]
    fn non_zip_is_rejected() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("bad.jar");
        std::fs::write(&path, b"not a zip").unwrap();
        let err = inspect_mod_jar(&path, "neoforge").unwrap_err();
        assert!(matches!(err, JarError::NotZip(_)));
        assert_eq!(err.into_api_error().code.as_deref(), Some("invalid_jar"));
    }

    #[test]
    fn zip_without_mod_metadata_is_rejected() {
        let (_dir, path) = write_jar(&[("README.txt", "hello")]);
        let err = inspect_mod_jar(&path, "neoforge").unwrap_err();
        assert_eq!(err, JarError::MissingMetadata);
        assert_eq!(
            err.into_api_error().code.as_deref(),
            Some("missing_mod_metadata")
        );
    }

    #[test]
    fn fabric_jar_into_neoforge_build_is_wrong_loader() {
        let json = r#"{"id":"lithium","version":"1.0"}"#;
        let (_dir, path) = write_jar(&[("fabric.mod.json", json)]);
        let err = inspect_mod_jar(&path, "neoforge").unwrap_err();
        assert!(matches!(err, JarError::WrongLoader(_)));
        assert_eq!(err.into_api_error().code.as_deref(), Some("wrong_loader"));
    }

    #[test]
    fn metadata_without_mod_id_is_rejected() {
        let toml = "[[mods]]\nversion = \"1.0\"\n";
        let (_dir, path) = write_jar(&[("META-INF/neoforge.mods.toml", toml)]);
        let err = inspect_mod_jar(&path, "neoforge").unwrap_err();
        assert_eq!(err, JarError::MissingModId);
    }

    #[test]
    fn placeholder_version_alone_is_not_reported() {
        let toml = "[[mods]]\nmodId = \"x\"\nversion = \"${file.jarVersion}\"\n";
        let (_dir, path) = write_jar(&[("META-INF/neoforge.mods.toml", toml)]);
        let meta = inspect_mod_jar(&path, "neoforge").unwrap();
        assert_eq!(meta.version, None);
    }

    #[test]
    fn manifest_version_fills_placeholder() {
        let toml = "[[mods]]\nmodId = \"x\"\nversion = \"${file.jarVersion}\"\n";
        let manifest = "Manifest-Version: 1.0\r\nImplementation-Version: 2.3.4\r\n\r\n";
        let (_dir, path) = write_jar(&[
            ("META-INF/neoforge.mods.toml", toml),
            ("META-INF/MANIFEST.MF", manifest),
        ]);
        let meta = inspect_mod_jar(&path, "neoforge").unwrap();
        let meta = fill_manifest_version(&path, meta);
        assert_eq!(meta.version.as_deref(), Some("2.3.4"));
    }

    #[test]
    fn filename_rejects_traversal_and_separators() {
        for bad in [
            "../evil.jar",
            "mods/evil.jar",
            "a\\b.jar",
            "..",
            "",
            "evil.zip",
            "bad name.jar",
            "semi;colon.jar",
        ] {
            assert!(
                sanitize_mod_filename(bad).is_err(),
                "должно быть отклонено: {bad:?}"
            );
        }
        assert_eq!(
            sanitize_mod_filename("sodium-0.6.13.jar").unwrap(),
            "sodium-0.6.13.jar"
        );
        assert_eq!(
            sanitize_mod_filename(" My_Mod+1.0.jar ").unwrap(),
            "My_Mod+1.0.jar"
        );
    }

    #[test]
    fn target_path_requires_mods_dir_and_jar() {
        assert_eq!(
            resolve_target_path(None, Some("sodium.jar")).unwrap(),
            "mods/sodium.jar"
        );
        assert_eq!(
            resolve_target_path(Some("mods/sub/sodium.jar"), None).unwrap(),
            "mods/sub/sodium.jar"
        );
        for bad in [
            Some("config/x.jar"),
            Some("mods/../../etc/x.jar"),
            Some("/mods/x.jar"),
            Some("mods/x.zip"),
            Some("mods"),
        ] {
            assert!(resolve_target_path(bad, None).is_err(), "{bad:?}");
        }
        assert!(resolve_target_path(Some("mods/x.jar"), None).is_ok());
    }

    #[test]
    fn upload_action_prefers_content_duplicate() {
        assert_eq!(decide_upload_action(true, true), UploadAction::Duplicate);
        assert_eq!(decide_upload_action(true, false), UploadAction::Duplicate);
        assert_eq!(decide_upload_action(false, true), UploadAction::Replace);
        assert_eq!(decide_upload_action(false, false), UploadAction::Insert);
    }
}
