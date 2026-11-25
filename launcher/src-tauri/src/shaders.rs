//! Поиск и загрузка шейдерпаков с Modrinth.
//!
//! Modrinth заблокирован в РФ, причём фильтрация режет и запросы через
//! сторонний HTTP-прокси: DPI видит имя хоста и в plaintext-заголовке
//! `CONNECT api.modrinth.com`, и в SNI внутри туннеля (проверено: squid
//! логирует успешный туннель, клиент получает инъекцию 400). Поэтому ВСЕ
//! запросы — и метаданные, и файлы — идут через публичный прокси
//! admin-server'а (`crates/admin-server/src/shaders_public.rs`): сервер
//! находится вне досягаемости блокировки. Домены Modrinth в squid.conf не
//! нужны и оставлены только для уже установленных версий лаунчера.

use std::path::PathBuf;

use serde::Serialize;
use tauri::AppHandle;

use crate::{backend, paths};

/// Хосты, с которых разрешено скачивание файлов шейдерпаков (проверка и на
/// клиенте, и на сервере): URL приходит из ответов API, но файл исполняется
/// на стороне пользователя — без белого списка подменённый ответ мог бы
/// записать произвольный файл.
const ALLOWED_FILE_HOSTS: [&str; 1] = ["cdn.modrinth.com"];

/// Клиент для прокси Modrinth на admin-server. Ходим так же, как и в
/// остальной бэкенд лаунчера — со встроенным прокси Stardust (домен
/// admin-server'а есть в его allowlist).
fn shaders_client() -> reqwest::Client {
    crate::commands::create_http_client(&crate::commands::ProxyType::Builtin)
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShaderSearchHit {
    pub project_id: String,
    pub slug: String,
    pub title: String,
    pub description: String,
    pub icon_url: Option<String>,
    pub downloads: u64,
    pub follows: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShaderVersion {
    pub id: String,
    pub version_number: String,
    pub name: String,
    pub game_versions: Vec<String>,
    pub loaders: Vec<String>,
    pub files: Vec<ShaderFile>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShaderFile {
    pub url: String,
    pub filename: String,
    pub size: u64,
    pub primary: bool,
}

/// Поиск шейдерпаков: только project_type:shader, сортировка по загрузкам.
#[tauri::command]
pub async fn search_shaders(query: Option<String>) -> Result<Vec<ShaderSearchHit>, String> {
    let client = shaders_client();
    let mut url = reqwest::Url::parse(&format!("{}/public/shaders/search", backend::admin_base_url()))
        .map_err(|e| format!("Некорректный адрес admin-server: {e}"))?;
    if let Some(q) = query.as_deref().map(str::trim).filter(|q| !q.is_empty()) {
        url.query_pairs_mut().append_pair("query", q);
    }
    let hits: serde_json::Value = client
        .get(url)
        .send()
        .await
        .map_err(|e| format!("Сервер: {e}"))?
        .error_for_status()
        .map_err(|e| format!("Сервер: {e}"))?
        .json()
        .await
        .map_err(|e| format!("Сервер: {e}"))?;
    parse_search(&hits)
}

/// Версии шейдерпака (файлы для скачивания). Идентификатор проекта
/// подставляется в URL, поэтому проверяем его формат: Modrinth ID —
/// 8 символов base62 или slug; всё остальное отбрасываем.
#[tauri::command]
pub async fn list_shader_versions(project_id: String) -> Result<Vec<ShaderVersion>, String> {
    let id = project_id.trim();
    if id.is_empty() || !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
        return Err("Некорректный идентификатор шейдерпака".to_string());
    }
    let client = shaders_client();
    let versions: serde_json::Value = client
        .get(format!(
            "{}/public/shaders/versions",
            backend::admin_base_url()
        ))
        .query(&[("projectId", id)])
        .send()
        .await
        .map_err(|e| format!("Сервер: {e}"))?
        .error_for_status()
        .map_err(|e| format!("Сервер: {e}"))?
        .json()
        .await
        .map_err(|e| format!("Сервер: {e}"))?;
    parse_versions(&versions)
}

/// Скачивает файл шейдерпака в `<игра>/shaderpacks/<filename>`.
///
/// Файл проксирует admin-server (`/public/shaders/download`): напрямую
/// cdn.modrinth.com из РФ недоступен. Прогресс идёт в отдельный канал,
/// чтобы не занимать глобальный прогресс и не блокировать «Играть».
#[tauri::command]
pub async fn download_shader(
    app: AppHandle,
    url: String,
    filename: String,
) -> Result<String, String> {
    // Файл разрешено брать только с CDN Modrinth (двойная проверка —
    // сервер тоже валидирует хост).
    let host = url::Url::parse(url.trim())
        .ok()
        .and_then(|u| u.host_str().map(String::from))
        .ok_or_else(|| "Некорректная ссылка на шейдерпак".to_string())?;
    if !ALLOWED_FILE_HOSTS.contains(&host.as_str()) {
        return Err(format!("Скачивание шейдерпаков с {host} не разрешено"));
    }
    // Имя файла — только имя: без путей и скрытых файлов.
    let name = filename.trim();
    if name.is_empty()
        || name.starts_with('.')
        || name.contains('/')
        || name.contains('\\')
        || name.contains("..")
    {
        return Err("Некорректное имя файла шейдерпака".to_string());
    }
    let data_dir = paths::data_dir(&app);
    let dir = paths::cached_game_dir(&data_dir).join("shaderpacks");
    tokio::fs::create_dir_all(&dir)
        .await
        .map_err(|e| format!("Не удалось создать папку шейдерпаков: {e}"))?;
    let dest: PathBuf = dir.join(name);

    let progress = crate::progress::Progress::for_java_download(app.clone());
    let client = shaders_client();
    // Файл качаем с нашего сервера, оригинальный URL — query-параметром.
    let proxied = reqwest::Url::parse(&format!(
        "{}/public/shaders/download",
        backend::admin_base_url()
    ))
    .map_err(|e| format!("Некорректный адрес admin-server: {e}"))?;
    let mut proxied = proxied;
    proxied.query_pairs_mut().append_pair("url", url.trim());
    crate::minecraft::download_to(
        &progress,
        &client,
        proxied.as_str(),
        &dest,
        &format!("Шейдерпак {name}"),
        None,
        None,
    )
    .await?;
    Ok(dest.to_string_lossy().into_owned())
}

fn parse_search(body: &serde_json::Value) -> Result<Vec<ShaderSearchHit>, String> {
    let hits = body
        .get("hits")
        .and_then(|h| h.as_array())
        .ok_or_else(|| "Modrinth: неожиданный ответ поиска".to_string())?;
    Ok(hits
        .iter()
        .filter_map(|hit| {
            Some(ShaderSearchHit {
                project_id: str_field(hit, "project_id")?,
                slug: str_field(hit, "slug").unwrap_or_default(),
                title: str_field(hit, "title").unwrap_or_default(),
                description: str_field(hit, "description").unwrap_or_default(),
                icon_url: hit.get("icon_url").and_then(|v| v.as_str()).map(String::from),
                downloads: hit.get("downloads").and_then(|v| v.as_u64()).unwrap_or(0),
                follows: hit.get("follows").and_then(|v| v.as_u64()).unwrap_or(0),
            })
        })
        .collect())
}

fn parse_versions(body: &serde_json::Value) -> Result<Vec<ShaderVersion>, String> {
    let versions = body
        .as_array()
        .ok_or_else(|| "Modrinth: неожиданный ответ версий".to_string())?;
    Ok(versions
        .iter()
        .map(|v| ShaderVersion {
            id: str_field(v, "id").unwrap_or_default(),
            version_number: str_field(v, "version_number").unwrap_or_default(),
            name: str_field(v, "name").unwrap_or_default(),
            game_versions: str_list(v, "game_versions"),
            loaders: str_list(v, "loaders"),
            files: v
                .get("files")
                .and_then(|f| f.as_array())
                .map(|files| {
                    files
                        .iter()
                        .filter_map(|f| {
                            Some(ShaderFile {
                                url: str_field(f, "url")?,
                                filename: str_field(f, "filename")?,
                                size: f.get("size").and_then(|s| s.as_u64()).unwrap_or(0),
                                primary: f
                                    .get("primary")
                                    .and_then(|p| p.as_bool())
                                    .unwrap_or(false),
                            })
                        })
                        .collect()
                })
                .unwrap_or_default(),
        })
        .collect())
}

fn str_field(value: &serde_json::Value, key: &str) -> Option<String> {
    value.get(key).and_then(|v| v.as_str()).map(String::from)
}

fn str_list(value: &serde_json::Value, key: &str) -> Vec<String> {
    value
        .get(key)
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str().map(String::from))
                .collect()
        })
        .unwrap_or_default()
}
