//! Публичный прокси Modrinth для вкладок «Шейдеры» и «Ресурспаки» лаунчера.
//!
//! Modrinth заблокирован в РФ, причём блокировка работает даже через
//! сторонний HTTP-прокси: DPI видит имя хоста и в plaintext-заголовке
//! `CONNECT api.modrinth.com`, и в SNI внутри туннеля, и подменяет ответ
//! (squid при этом логирует успешный туннель — клиент получает инъекцию).
//! Поэтому лаунчер ходит не в Modrinth, а в нас: сервер находится вне
//! досягаемости этой фильтрации и отдаёт лаунчеру и метаданные, и файлы.
//!
//! Прокси «тупой» — тело Modrinth отдаётся как есть: маппинг полей делает
//! Rust-сторона лаунчера (`launcher/src-tauri/src/shaders.rs`), поэтому
//! структура ответов админ-сервера не дублируется. Download разрешён только
//! с CDN Modrinth: эндпоинт не должен превращаться в открытый прокси.

use std::time::Duration;

use axum::{
    body::Body,
    extract::{Query, State},
    http::{header, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use serde::Deserialize;

use crate::{ApiError, Shared};

/// Таймауты внешних запросов: у метаданных — короткий, у файлов — щедрый
/// (шейдерпаки бывают в десятки мегабайт).
const UPSTREAM_TIMEOUT: Duration = Duration::from_secs(20);
const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(300);

const MODRINTH_API: &str = "https://api.modrinth.com/v2";
/// Хосты, с которых разрешено проксировать файлы. URL приходит параметром,
/// без белого списка эндпоинт качал бы произвольные адреса.
const ALLOWED_FILE_HOSTS: [&str; 1] = ["cdn.modrinth.com"];

#[derive(Deserialize)]
pub(crate) struct PacksSearchQuery {
    query: Option<String>,
}

#[derive(Deserialize)]
pub(crate) struct PacksVersionsQuery {
    #[serde(rename = "projectId")]
    project_id: String,
}

#[derive(Deserialize)]
pub(crate) struct PacksDownloadQuery {
    url: String,
}

/// Поиск паков (шейдерпаки/ресурспаки): как в лаунчере — топ по загрузкам,
/// project_type задаёт категорию Modrinth.
async fn packs_search(
    state: &Shared,
    query: Option<String>,
    project_type: &str,
) -> Result<Response, ApiError> {
    let mut url = reqwest::Url::parse(&format!("{MODRINTH_API}/search"))
        .map_err(|e| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    {
        let mut pairs = url.query_pairs_mut();
        pairs.append_pair("limit", "24");
        pairs.append_pair("index", "downloads");
        pairs.append_pair(
            "facets",
            &format!(r#"[["project_type:{project_type}"]]"#),
        );
        if let Some(query) = query.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
            pairs.append_pair("query", query);
        }
    }
    proxy_json(state, url.as_str()).await
}

/// Версии пака. Идентификатор подставляется в URL, поэтому формат
/// проверяем: Modrinth ID — base62/slug, всё остальное отбрасываем.
async fn packs_versions(
    state: &Shared,
    project_id: &str,
) -> Result<Response, ApiError> {
    let id = project_id.trim();
    if id.is_empty() || !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
        return Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            "Некорректный идентификатор пака",
        ));
    }
    proxy_json(state, &format!("{MODRINTH_API}/project/{id}/version")).await
}

/// Стрим файла пака с CDN Modrinth клиенту лаунчера.
async fn packs_download(state: &Shared, url: &str) -> Result<Response, ApiError> {
    let parsed = reqwest::Url::parse(url.trim())
        .map_err(|_| ApiError::new(StatusCode::BAD_REQUEST, "Некорректная ссылка на файл"))?;
    let host = parsed
        .host_str()
        .ok_or_else(|| ApiError::new(StatusCode::BAD_REQUEST, "Некорректная ссылка на файл"))?;
    if !ALLOWED_FILE_HOSTS.contains(&host) {
        return Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            format!("Скачивание файлов с {host} не разрешено"),
        ));
    }
    let resp = state
        .http
        .get(parsed)
        .timeout(DOWNLOAD_TIMEOUT)
        .send()
        .await
        .map_err(upstream)?;
    let status = resp.status();
    if !status.is_success() {
        return Err(ApiError::new(
            StatusCode::BAD_GATEWAY,
            format!("Modrinth ответил {status}"),
        ));
    }
    let content_type = resp
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .map(|v| v.to_string())
        .unwrap_or_else(|| "application/octet-stream".to_string());
    // Стрим: паки бывают десятки МБ, буферизовать их в памяти не нужно.
    let stream = resp.bytes_stream();
    Ok((
        [(header::CONTENT_TYPE, content_type)],
        Body::from_stream(stream),
    )
        .into_response())
}

// --- Хендлеры «Шейдеры» ---

pub(crate) async fn shaders_search(
    State(state): State<Shared>,
    Query(q): Query<PacksSearchQuery>,
) -> Result<Response, ApiError> {
    packs_search(&state, q.query, "shader").await
}

pub(crate) async fn shaders_versions(
    State(state): State<Shared>,
    Query(q): Query<PacksVersionsQuery>,
) -> Result<Response, ApiError> {
    packs_versions(&state, &q.project_id).await
}

pub(crate) async fn shaders_download(
    State(state): State<Shared>,
    Query(q): Query<PacksDownloadQuery>,
) -> Result<Response, ApiError> {
    packs_download(&state, &q.url).await
}

// --- Хендлеры «Ресурспаки»: та же логика, другой project_type ---

pub(crate) async fn resourcepacks_search(
    State(state): State<Shared>,
    Query(q): Query<PacksSearchQuery>,
) -> Result<Response, ApiError> {
    packs_search(&state, q.query, "resourcepack").await
}

pub(crate) async fn resourcepacks_versions(
    State(state): State<Shared>,
    Query(q): Query<PacksVersionsQuery>,
) -> Result<Response, ApiError> {
    packs_versions(&state, &q.project_id).await
}

pub(crate) async fn resourcepacks_download(
    State(state): State<Shared>,
    Query(q): Query<PacksDownloadQuery>,
) -> Result<Response, ApiError> {
    packs_download(&state, &q.url).await
}

/// GET до Modrinth с прокидыванием JSON-тела как есть.
async fn proxy_json(state: &Shared, url: &str) -> Result<Response, ApiError> {
    let resp = state
        .http
        .get(url)
        .timeout(UPSTREAM_TIMEOUT)
        .send()
        .await
        .map_err(upstream)?;
    let status = resp.status();
    let body: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| ApiError::new(StatusCode::BAD_GATEWAY, format!("Modrinth: {e}")))?;
    // Ошибки upstream (404 проекта и т.п.) пробрасываем тем же кодом.
    if status.is_success() {
        Ok(Json(body).into_response())
    } else {
        Err(ApiError::new(
            StatusCode::BAD_GATEWAY,
            format!("Modrinth ответил {status}"),
        ))
    }
}

fn upstream(e: reqwest::Error) -> ApiError {
    ApiError::new(StatusCode::BAD_GATEWAY, format!("Modrinth: {e}"))
}
