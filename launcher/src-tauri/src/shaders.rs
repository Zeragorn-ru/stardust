//! Поиск и загрузка шейдерпаков с Modrinth.
//!
//! Modrinth заблокирован в РФ, поэтому ВСЕ запросы к его API и CDN идут
//! через встроенный прокси Stardust — независимо от того, какой прокси
//! выбрал пользователь: «Без прокси» не должен ломать вкладку шейдеров.
//! Домены прокси перечислены в deploy/squid.conf (секция Modrinth).

use std::path::PathBuf;

use serde::Serialize;
use tauri::AppHandle;

use crate::paths;

pub const MODRINTH_API: &str = "https://api.modrinth.com/v2";

/// Хосты, с которых разрешено скачивание файлов шейдерпаков.
/// URL приходит из ответов API, но исполняется на стороне пользователя:
/// без белого списка подменённый ответ мог бы записать произвольный файл.
const ALLOWED_FILE_HOSTS: [&str; 1] = ["cdn.modrinth.com"];

/// Отдельный клиент только для Modrinth: всегда через встроенный прокси.
fn modrinth_client() -> reqwest::Client {
    let mut builder = reqwest::Client::builder()
        .user_agent(concat!("stardust-launcher/", env!("CARGO_PKG_VERSION")))
        .connect_timeout(std::time::Duration::from_secs(10))
        .read_timeout(std::time::Duration::from_secs(60))
        .tcp_nodelay(true);
    // Прокси обязателен: без него у пользователей из РФ запросы не проходят.
    if let Ok(p) = reqwest::Proxy::all(crate::commands::BUILTIN_PROXY_URL) {
        builder = builder.proxy(p);
    }
    builder.build().expect("не удалось создать HTTP-клиент Modrinth")
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
    let mut url = format!(
        "{MODRINTH_API}/search?limit=24&index=downloads&facets=%5B%5B%22project_type%3Ashader%22%5D%5D"
    );
    if let Some(q) = query.as_deref().map(str::trim).filter(|q| !q.is_empty()) {
        url.push_str(&format!("&query={}", urlencode(q)));
    }
    let body: serde_json::Value = modrinth_client()
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("Modrinth: {e}"))?
        .error_for_status()
        .map_err(|e| format!("Modrinth: {e}"))?
        .json()
        .await
        .map_err(|e| format!("Modrinth: {e}"))?;
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

/// Версии шейдерпака (файлы для скачивания). Идентификатор проекта
/// подставляется в URL, поэтому проверяем его формат: Modrinth ID —
/// 8 символов base62 или slug; всё остальное отбрасываем.
#[tauri::command]
pub async fn list_shader_versions(project_id: String) -> Result<Vec<ShaderVersion>, String> {
    let id = project_id.trim();
    if id.is_empty() || !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
        return Err("Некорректный идентификатор шейдерпака".to_string());
    }
    let body: serde_json::Value = modrinth_client()
        .get(format!("{MODRINTH_API}/project/{id}/version"))
        .send()
        .await
        .map_err(|e| format!("Modrinth: {e}"))?
        .error_for_status()
        .map_err(|e| format!("Modrinth: {e}"))?
        .json()
        .await
        .map_err(|e| format!("Modrinth: {e}"))?;
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

/// Скачивает файл шейдерпака в `<игра>/shaderpacks/<filename>`.
///
/// Как и поиск — всегда через встроенный прокси. Прогресс идёт в отдельный
/// канал, чтобы не занимать глобальный прогресс и не блокировать «Играть».
#[tauri::command]
pub async fn download_shader(
    app: AppHandle,
    url: String,
    filename: String,
) -> Result<String, String> {
    // Файл разрешено брать только с CDN Modrinth.
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
    let client = modrinth_client();
    crate::minecraft::download_to(
        &progress,
        &client,
        url.trim(),
        &dest,
        &format!("Шейдерпак {name}"),
        None,
        None,
    )
    .await?;
    Ok(dest.to_string_lossy().into_owned())
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

/// Минимальный percent-encoding для query-параметра Modrinth.
fn urlencode(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for byte in text.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(byte as char)
            }
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}
