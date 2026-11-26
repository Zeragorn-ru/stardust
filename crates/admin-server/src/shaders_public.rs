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

/// Категории Modrinth, которые не показываем в каталоге и не отдаём версии.
/// «Читёрской» категории на Modrinth нет; cursed — куда авторы кладут
/// X-ray и прочий сомнительный контент. Проверяется на сервере: клиенту
/// такие паки не видны вовсе (в search отфильтрованы, у versions — отказ).
const BANNED_CATEGORIES: [&str; 1] = ["cursed"];

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

/// Проект помечен запрещённой категорией?
fn has_banned_category(categories: &serde_json::Value) -> bool {
    categories
        .as_array()
        .is_some_and(|list| {
            list.iter()
                .filter_map(|value| value.as_str())
                .any(|category| BANNED_CATEGORIES.contains(&category))
        })
}

/// Поиск паков (шейдерпаки/ресурспаки): как в лаунчере — топ по загрузкам,
/// project_type задаёт категорию Modrinth. Хиты с запрещёнными категориями
/// вырезаются из ответа.
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
    let mut body = fetch_json(state, url.as_str()).await?;
    if let Some(hits) = body
        .get_mut("hits")
        .and_then(|hits| hits.as_array_mut())
    {
        hits.retain(|hit| !has_banned_category(hit.get("categories").unwrap_or(&serde_json::Value::Null)));
    }
    Ok(Json(body).into_response())
}

/// Версии пака. Идентификатор подставляется в URL, поэтому формат
/// проверяем: Modrinth ID — base62/slug, всё остальное отбрасываем.
/// У версий категории нет — сверяемся с категориями самого проекта.
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
    let project = fetch_json(state, &format!("{MODRINTH_API}/project/{id}")).await?;
    if has_banned_category(project.get("categories").unwrap_or(&serde_json::Value::Null)) {
        return Err(ApiError::new(
            StatusCode::FORBIDDEN,
            "Этот пак недоступен в лаунчере",
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

/// GET до Modrinth, тело разбирается как JSON (для фильтрации).
async fn fetch_json(state: &Shared, url: &str) -> Result<serde_json::Value, ApiError> {
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
    if status.is_success() {
        Ok(body)
    } else {
        Err(ApiError::new(
            StatusCode::BAD_GATEWAY,
            format!("Modrinth ответил {status}"),
        ))
    }
}

/// GET до Modrinth с прокидыванием JSON-тела как есть.
async fn proxy_json(state: &Shared, url: &str) -> Result<Response, ApiError> {
    let body = fetch_json(state, url).await?;
    Ok(Json(body).into_response())
}

fn upstream(e: reqwest::Error) -> ApiError {
    ApiError::new(StatusCode::BAD_GATEWAY, format!("Modrinth: {e}"))
}
