//! Поиск и загрузка шейдерпаков и ресурспаков с Modrinth.
//!
//! Modrinth заблокирован в РФ, причём фильтрация режет и запросы через
//! сторонний HTTP-прокси: DPI видит имя хоста и в plaintext-заголовке
//! `CONNECT api.modrinth.com`, и в SNI внутри туннеля (проверено: squid
//! логирует успешный туннель, клиент получает инъекцию 400). Поэтому ВСЕ
//! запросы — и метаданные, и файлы — идут через публичный прокси
//! admin-server'а (`crates/admin-server/src/shaders_public.rs`): сервер
//! находится вне досягаемости блокировки. Домены Modrinth в squid.conf не
//! нужны и оставлены только для уже установленных версий лаунчера.
//!
//! Ресурспаки — тот же флоу один в один (`PackKind`): другой project_type
//! на Modrinth, другой каталог (`<игра>/resourcepacks`) и другой префикс
//! прокси на admin-server.

use std::path::{Path, PathBuf};

use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine as _;
use serde::Serialize;
use tauri::{AppHandle, Manager};

use crate::{backend, paths};

/// Хосты, с которых разрешено скачивание файлов паков (проверка и на
/// клиенте, и на сервере): URL приходит из ответов API, но файл исполняется
/// на стороне пользователя — без белого списка подменённый ответ мог бы
/// записать произвольный файл.
const ALLOWED_FILE_HOSTS: [&str; 1] = ["cdn.modrinth.com"];

/// Суффикс файла-иконки рядом с архивом пака: `Sphunculus.zip.icon.png`.
/// list_* отфильтровывает такие файлы, delete удаляет их вместе с паком.
pub const ICON_SUFFIX: &str = ".icon.png";

/// Вспомогательный файл каталога паков (иконка, настройки Iris, временный
/// недокачанный) — не сам пак. Очистка и отчёт о сторонних паках их пропускают.
pub fn is_pack_aux_file(name: &str) -> bool {
    name.ends_with(ICON_SUFFIX)
        || name.to_lowercase().ends_with(".txt")
        || name.ends_with(".download-")
}

/// Реестр паков, скачанных через лаунчер: `<data_dir>/launcher-packs.json`.
/// По нему работает «очистка сторонних файлов» (режим из админки,
/// `ExternalModPolicy.purge_external`): всё, чего нет в реестре, считается
/// подкинутым вручную и удаляется при запуске игры. При первом чтении
/// отсутствующий реестр засеивается паками с иконкой-маркером — они были
/// скачаны через лаунчер до введения реестра.
const REGISTRY_FILE: &str = "launcher-packs.json";

/// Какой пак качаем: шейдерпак или ресурспак. От вида зависят только
/// project_type на Modrinth, путь прокси на admin-server и каталог.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PackKind {
    Shader,
    ResourcePack,
}

impl PackKind {
    /// Сегмент публичного прокси admin-server'а: подставляется в
    /// `{base}/public/{segment}/...` (сами префиксы /public/ там уже есть).
    fn proxy_base(self) -> &'static str {
        match self {
            PackKind::Shader => "shaders",
            PackKind::ResourcePack => "resourcepacks",
        }
    }

    /// Каталог внутри `<игра>/`.
    fn dir_name(self) -> &'static str {
        match self {
            PackKind::Shader => "shaderpacks",
            PackKind::ResourcePack => "resourcepacks",
        }
    }

    /// Человекочитаемое имя для сообщений об ошибках.
    fn noun(self) -> &'static str {
        match self {
            PackKind::Shader => "шейдерпак",
            PackKind::ResourcePack => "ресурспак",
        }
    }

    fn dir(self, app: &AppHandle) -> PathBuf {
        paths::cached_game_dir(&paths::data_dir(app)).join(self.dir_name())
    }
}

/// Клиент для запросов к прокси Modrinth на admin-server: общий HTTP-клиент
/// лаунчера, построенный по прокси, выбранному пользователем в настройках
/// (`AppState.http` пересобирается при каждом сохранении настроек).
/// Сам admin-server доступен из РФ напрямую, поэтому «Без прокси» тоже
/// работает — Modrinth лифтит уже сервер.
fn packs_client(app: &AppHandle) -> reqwest::Client {
    app.state::<crate::commands::AppState>().http()
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PackSearchHit {
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
pub struct PackVersion {
    pub id: String,
    pub version_number: String,
    pub name: String,
    pub game_versions: Vec<String>,
    pub loaders: Vec<String>,
    pub files: Vec<PackFile>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PackFile {
    pub url: String,
    pub filename: String,
    pub size: u64,
    pub primary: bool,
}

/// Поиск паков: только заданный project_type, сортировка по загрузкам.
async fn search_packs(
    app: AppHandle,
    kind: PackKind,
    query: Option<String>,
) -> Result<Vec<PackSearchHit>, String> {
    let client = packs_client(&app);
    let mut url = reqwest::Url::parse(&format!(
        "{}/public/{}/search",
        backend::admin_base_url(),
        kind.proxy_base().trim_start_matches('/')
    ))
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

/// Версии пака (файлы для скачивания). Идентификатор проекта
/// подставляется в URL, поэтому проверяем его формат: Modrinth ID —
/// 8 символов base62 или slug; всё остальное отбрасываем.
async fn list_pack_versions(
    app: AppHandle,
    kind: PackKind,
    project_id: String,
) -> Result<Vec<PackVersion>, String> {
    let id = project_id.trim();
    if id.is_empty() || !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
        return Err("Некорректный идентификатор пака".to_string());
    }
    let client = packs_client(&app);
    let versions: serde_json::Value = client
        .get(format!(
            "{}/public/{}/versions",
            backend::admin_base_url(),
            kind.proxy_base().trim_start_matches('/')
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

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadedPack {
    pub filename: String,
    pub size: u64,
    /// Иконка пака (`<filename>.icon.png`), base64 PNG; None — иконки нет.
    pub icon_base64: Option<String>,
}

/// Каталог паков активной сборки (создаётся при скачивании).
fn packs_dir(app: &AppHandle, kind: PackKind) -> PathBuf {
    kind.dir(app)
}

// --- Реестр лаунчерных паков ---

#[derive(Debug, Default, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PackRegistry {
    #[serde(default)]
    pub shaders: Vec<String>,
    #[serde(default)]
    pub resourcepacks: Vec<String>,
}

impl PackRegistry {
    fn names_mut(&mut self, kind: PackKind) -> &mut Vec<String> {
        match kind {
            PackKind::Shader => &mut self.shaders,
            PackKind::ResourcePack => &mut self.resourcepacks,
        }
    }

    /// Имена паков данного вида (для очистки при запуске игры).
    pub fn names(&self, kind: PackKind) -> &[String] {
        match kind {
            PackKind::Shader => &self.shaders,
            PackKind::ResourcePack => &self.resourcepacks,
        }
    }
}

fn registry_path(app: &AppHandle) -> PathBuf {
    paths::data_dir(app).join(REGISTRY_FILE)
}

/// Читает реестр; заодно миграция: отсутствующий файл засеивается паками
/// с иконкой-маркером (иконку создаёт только наш download) — так паки,
/// скачанные через лаунчер до введения реестра, не считаются сторонними.
/// Ошибки чтения/записи не роняют вызывающий флоу: реестр — best effort,
/// худший случай — пак придётся скачать заново.
pub async fn load_pack_registry(app: &AppHandle) -> PackRegistry {
    let path = registry_path(app);
    if let Ok(bytes) = tokio::fs::read(&path).await {
        if let Ok(registry) = serde_json::from_slice::<PackRegistry>(&bytes) {
            return registry;
        }
    }
    let mut registry = PackRegistry::default();
    for kind in [PackKind::Shader, PackKind::ResourcePack] {
        let dir = packs_dir(app, kind);
        let Ok(mut entries) = tokio::fs::read_dir(&dir).await else {
            continue;
        };
        while let Ok(Some(entry)) = entries.next_entry().await {
            let name = entry.file_name().to_string_lossy().into_owned();
            if dir.join(format!("{name}{ICON_SUFFIX}")).exists() && valid_pack_filename(&name) {
                registry.names_mut(kind).push(name);
            }
        }
        registry.names_mut(kind).sort();
    }
    save_pack_registry(app, &registry).await;
    registry
}

pub async fn save_pack_registry(app: &AppHandle, registry: &PackRegistry) {
    let path = registry_path(app);
    if let Ok(bytes) = serde_json::to_vec_pretty(registry) {
        let _ = tokio::fs::write(&path, bytes).await;
    }
}

/// Регистрирует пак после успешного скачивания (дедуп по имени).
async fn register_pack(app: &AppHandle, kind: PackKind, name: &str) {
    let mut registry = load_pack_registry(app).await;
    let names = registry.names_mut(kind);
    if !names.iter().any(|n| n == name) {
        names.push(name.to_string());
        names.sort();
        save_pack_registry(app, &registry).await;
    }
}

/// Убирает пак из реестра при удалении.
async fn unregister_pack(app: &AppHandle, kind: PackKind, name: &str) {
    let mut registry = load_pack_registry(app).await;
    let names = registry.names_mut(kind);
    let before = names.len();
    names.retain(|n| n != name);
    if names.len() != before {
        save_pack_registry(app, &registry).await;
    }
}

/// Валидирует имя файла пака: только имя, без путей и скрытых файлов.
fn valid_pack_filename(name: &str) -> bool {
    !name.is_empty()
        && !name.starts_with('.')
        && !name.contains('/')
        && !name.contains('\\')
        && !name.contains("..")
}

/// Список скачанных паков (файлы в `<игра>/<каталог вида>/`).
async fn list_downloaded_packs(
    app: AppHandle,
    kind: PackKind,
) -> Result<Vec<DownloadedPack>, String> {
    let dir = packs_dir(&app, kind);
    let mut out = Vec::new();
    // Папки может ещё не существовать (ни один пак не скачан) — это
    // не ошибка, а просто пустой список. Иначе вкладка навсегда
    // залипала бы на «Загрузка…».
    let mut entries = match tokio::fs::read_dir(&dir).await {
        Ok(entries) => entries,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(out),
        Err(e) => {
            return Err(format!(
                "Не удалось прочитать папку {}: {e}",
                kind.dir_name()
            ))
        }
    };
    while let Some(entry) = entries
        .next_entry()
        .await
        .map_err(|e| format!("Не удалось прочитать папку {}: {e}", kind.dir_name()))?
    {
        let name = entry.file_name().to_string_lossy().into_owned();
        // В списке не показываем: каталоги, временные файлы (*.download-*),
        // файлы-иконки (*.icon.png) и текстовые файлы настроек Iris
        // (`<пак>.zip.txt` — их создаёт сама игра рядом с архивом).
        if !valid_pack_filename(&name)
            || name.ends_with(".download-")
            || name.ends_with(ICON_SUFFIX)
            || name.to_lowercase().ends_with(".txt")
        {
            continue;
        }
        let Ok(meta) = entry.metadata().await else {
            continue;
        };
        if !meta.is_file() {
            continue;
        }
        // Иконка рядом — `<filename>.icon.png`; читаем её в base64, если есть.
        let icon_base64 = read_icon_base64(&dir.join(format!("{name}{ICON_SUFFIX}")));
        out.push(DownloadedPack {
            filename: name,
            size: meta.len(),
            icon_base64,
        });
    }
    out.sort_by_key(|a| a.filename.to_lowercase());
    Ok(out)
}

/// Читает PNG-иконку и кодирует в base64; отсутствующий/нечитаемый файл —
/// не ошибка, просто иконки в списке не будет.
fn read_icon_base64(path: &Path) -> Option<String> {
    let bytes = std::fs::read(path).ok()?;
    if bytes.is_empty() {
        return None;
    }
    Some(B64.encode(bytes))
}

/// Удаляет скачанный пак по имени файла (и его иконку рядом, если есть).
async fn delete_pack(app: AppHandle, kind: PackKind, filename: String) -> Result<(), String> {
    let name = filename.trim();
    if !valid_pack_filename(name) {
        return Err(format!("Некорректное имя файла {}", kind.noun()));
    }
    let dir = packs_dir(&app, kind);
    let path = dir.join(name);
    // Double-check, что ушли не выше каталога паков.
    if path.parent() != Some(dir.as_path()) {
        return Err(format!("Некорректное имя файла {}", kind.noun()));
    }
    tokio::fs::remove_file(&path)
        .await
        .map_err(|e| format!("Не удалось удалить {}: {e}", kind.noun()))?;
    // Иконка — необязательный сосед: нет её или не удалилась, пак уже удалён.
    let icon_path = dir.join(format!("{name}{ICON_SUFFIX}"));
    if icon_path.exists() {
        let _ = tokio::fs::remove_file(&icon_path).await;
    }
    unregister_pack(&app, kind, name).await;
    Ok(())
}

/// Скачивает файл пака в `<игра>/<каталог вида>/<filename>`, рядом — иконка
/// пака `<filename>.icon.png` (best effort: нет иконки — нет файла).
///
/// Файл проксирует admin-server (`/public/<вид>/download`): напрямую
/// cdn.modrinth.com из РФ недоступен. Прогресс идёт в отдельный канал,
/// чтобы не занимать глобальный прогресс и не блокировать «Играть».
async fn download_pack(
    app: AppHandle,
    kind: PackKind,
    url: String,
    filename: String,
    icon_url: Option<String>,
) -> Result<String, String> {
    // Файл разрешено брать только с CDN Modrinth (двойная проверка —
    // сервер тоже валидирует хост).
    let host = url::Url::parse(url.trim())
        .ok()
        .and_then(|u| u.host_str().map(String::from))
        .ok_or_else(|| format!("Некорректная ссылка на {}", kind.noun()))?;
    if !ALLOWED_FILE_HOSTS.contains(&host.as_str()) {
        return Err(format!(
            "Скачивание {} с {host} не разрешено",
            match kind {
                PackKind::Shader => "шейдерпаков",
                PackKind::ResourcePack => "ресурс-паков",
            }
        ));
    }
    // Имя файла — только имя: без путей и скрытых файлов.
    let name = filename.trim();
    if !valid_pack_filename(name) {
        return Err(format!("Некорректное имя файла {}", kind.noun()));
    }
    let data_dir = paths::data_dir(&app);
    let dir = paths::cached_game_dir(&data_dir).join(kind.dir_name());
    tokio::fs::create_dir_all(&dir)
        .await
        .map_err(|e| format!("Не удалось создать папку {}: {e}", kind.dir_name()))?;
    let dest: PathBuf = dir.join(name);

    let progress = crate::progress::Progress::for_java_download(app.clone());
    let client = packs_client(&app);
    // Файл качаем с нашего сервера, оригинальный URL — query-параметром.
    let proxied = reqwest::Url::parse(&format!(
        "{}/public/{}/download",
        backend::admin_base_url(),
        kind.proxy_base().trim_start_matches('/')
    ))
    .map_err(|e| format!("Некорректный адрес admin-server: {e}"))?;
    let mut proxied = proxied;
    proxied.query_pairs_mut().append_pair("url", url.trim());
    crate::minecraft::download_to(
        &progress,
        &client,
        proxied.as_str(),
        &dest,
        &format!("Скачать {}", kind.noun()),
        None,
        None,
    )
    .await?;

    // Иконка пака: мелкий PNG с того же CDN, качаем через тот же прокси
    // тем же клиентом. Best effort — неудача не отменяет скачанный пак.
    if let Some(icon) = icon_url
        .as_deref()
        .map(str::trim)
        .filter(|u| !u.is_empty())
        .and_then(|u| {
            url::Url::parse(u).ok().and_then(|parsed| {
                let allowed = parsed
                    .host_str()
                    .is_some_and(|h| ALLOWED_FILE_HOSTS.contains(&h));
                allowed.then_some(parsed)
            })
        })
    {
        let mut proxied_icon = reqwest::Url::parse(&format!(
            "{}/public/{}/download",
            backend::admin_base_url(),
            kind.proxy_base().trim_start_matches('/')
        ))
        .map_err(|e| format!("Некорректный адрес admin-server: {e}"))?;
        proxied_icon.query_pairs_mut().append_pair("url", icon.as_str());
        if let Ok(bytes) = client.get(proxied_icon).send().await {
            let icon_dest = dir.join(format!("{name}{ICON_SUFFIX}"));
            if let Ok(body) = bytes.bytes().await {
                if !body.is_empty() {
                    let _ = tokio::fs::write(&icon_dest, &body).await;
                }
            }
        }
    }
    // Пак скачан нами — фиксируем в реестре, чтобы очистка сторонних файлов
    // его не тронула.
    register_pack(&app, kind, name).await;
    Ok(dest.to_string_lossy().into_owned())
}

// --- Tauri-команды: шейдеры ---

#[tauri::command]
pub async fn search_shaders(
    app: AppHandle,
    query: Option<String>,
) -> Result<Vec<PackSearchHit>, String> {
    search_packs(app, PackKind::Shader, query).await
}

#[tauri::command]
pub async fn list_shader_versions(
    app: AppHandle,
    project_id: String,
) -> Result<Vec<PackVersion>, String> {
    list_pack_versions(app, PackKind::Shader, project_id).await
}

#[tauri::command]
pub async fn list_downloaded_shaders(app: AppHandle) -> Result<Vec<DownloadedPack>, String> {
    list_downloaded_packs(app, PackKind::Shader).await
}

#[tauri::command]
pub async fn delete_shader(app: AppHandle, filename: String) -> Result<(), String> {
    delete_pack(app, PackKind::Shader, filename).await
}

#[tauri::command]
pub async fn download_shader(
    app: AppHandle,
    url: String,
    filename: String,
    icon_url: Option<String>,
) -> Result<String, String> {
    download_pack(app, PackKind::Shader, url, filename, icon_url).await
}

// --- Tauri-команды: ресурспаки ---

#[tauri::command]
pub async fn search_resourcepacks(
    app: AppHandle,
    query: Option<String>,
) -> Result<Vec<PackSearchHit>, String> {
    search_packs(app, PackKind::ResourcePack, query).await
}

#[tauri::command]
pub async fn list_resourcepack_versions(
    app: AppHandle,
    project_id: String,
) -> Result<Vec<PackVersion>, String> {
    list_pack_versions(app, PackKind::ResourcePack, project_id).await
}

#[tauri::command]
pub async fn list_downloaded_resourcepacks(app: AppHandle) -> Result<Vec<DownloadedPack>, String> {
    list_downloaded_packs(app, PackKind::ResourcePack).await
}

#[tauri::command]
pub async fn delete_resourcepack(app: AppHandle, filename: String) -> Result<(), String> {
    delete_pack(app, PackKind::ResourcePack, filename).await
}

#[tauri::command]
pub async fn download_resourcepack(
    app: AppHandle,
    url: String,
    filename: String,
    icon_url: Option<String>,
) -> Result<String, String> {
    download_pack(app, PackKind::ResourcePack, url, filename, icon_url).await
}

fn parse_search(body: &serde_json::Value) -> Result<Vec<PackSearchHit>, String> {
    let hits = body
        .get("hits")
        .and_then(|h| h.as_array())
        .ok_or_else(|| "Modrinth: неожиданный ответ поиска".to_string())?;
    Ok(hits
        .iter()
        .filter_map(|hit| {
            Some(PackSearchHit {
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

fn parse_versions(body: &serde_json::Value) -> Result<Vec<PackVersion>, String> {
    let versions = body
        .as_array()
        .ok_or_else(|| "Modrinth: неожиданный ответ версий".to_string())?;
    Ok(versions
        .iter()
        .map(|v| PackVersion {
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
                            Some(PackFile {
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
