//! Поиск модов на внешних хостингах (Modrinth, CurseForge).
//!
//! Админка не ходит в эти API напрямую: у CurseForge нет CORS и нужен
//! API-ключ, а запросы к Modrinth должны идти с нашим User-Agent. Здесь —
//! тонкий прокси: поиск, список версий под MC-версию и загрузчик сборки, и
//! резолв одной подходящей версии (для зависимостей). Сами JAR-ы скачивает
//! `install_mods` из main.rs — тоже на сервере, без трафика через браузер.

use axum::{
    extract::{Query, State},
    http::{HeaderMap, StatusCode},
    Json,
};
use serde::{Deserialize, Serialize};
use std::time::Duration;
use store::SETTING_CURSEFORGE_API_KEY;

use crate::{internal, require_admin, ApiError, Shared};

/// Таймаут внешнего запроса: хостинги иногда «висят», админка ждать не должна.
const UPSTREAM_TIMEOUT: Duration = Duration::from_secs(20);

/// Сколько результатов отдаём на страницу поиска.
const SEARCH_LIMIT: usize = 24;
/// Сколько версий проекта показываем (у модов их бывают сотни).
const VERSIONS_LIMIT: usize = 30;

/// `gameId=432` — Minecraft, `classId=6` — моды в CurseForge.
const CURSEFORGE_GAME_ID: &str = "432";
const CURSEFORGE_CLASS_ID: &str = "6";

#[derive(Deserialize)]
pub(crate) struct SearchQuery {
    /// `modrinth` (по умолчанию) или `curseforge`.
    source: Option<String>,
    query: Option<String>,
    /// Загрузчик сборки: neoforge/forge/fabric/quilt.
    loader: Option<String>,
    #[serde(rename = "mcVersion")]
    mc_version: Option<String>,
    /// Смещение для пагинации (Load more). По умолчанию 0.
    #[serde(default)]
    offset: usize,
    /// Сортировка: `relevance` | `downloads` | `newest` | `updated` | `follows`.
    sort: Option<String>,
    /// Категории через запятую: `optimization,performance`.
    categories: Option<String>,
}

#[derive(Deserialize)]
pub(crate) struct DetailQuery {
    source: Option<String>,
    #[serde(rename = "projectId")]
    project_id: String,
}

#[derive(Deserialize)]
pub(crate) struct VersionsQuery {
    source: Option<String>,
    #[serde(rename = "projectId")]
    project_id: String,
    loader: Option<String>,
    #[serde(rename = "mcVersion")]
    mc_version: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ModHit {
    source: String,
    id: String,
    slug: String,
    title: String,
    description: String,
    author: String,
    icon_url: Option<String>,
    downloads: i64,
    categories: Vec<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ModDependency {
    #[serde(skip_serializing_if = "Option::is_none")]
    project_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    version_id: Option<String>,
    /// `required` | `optional` | `incompatible` | `embedded` | `unknown`.
    dependency_type: String,
    /// Название проекта-зависимости, если удалось получить.
    #[serde(skip_serializing_if = "Option::is_none")]
    title: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ModVersion {
    id: String,
    name: String,
    version_number: String,
    /// `release` | `beta` | `alpha`.
    version_type: String,
    date_published: Option<String>,
    downloads: i64,
    file_name: String,
    /// `None` — хостинг не отдал прямую ссылку (CurseForge запрещает
    /// сторонние загрузки у части авторов). Фронт покажет это как ошибку.
    file_url: Option<String>,
    file_size: i64,
    /// `client_only` | `server_only` | `client_and_server` | `unknown`.
    /// Из него админка выводит сторону файла (`side`), чтобы клиентский мод
    /// не попал на сервер.
    environment: String,
    dependencies: Vec<ModDependency>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SearchResult {
    hits: Vec<ModHit>,
    /// Общее число результатов (для показа "Показать ещё").
    total_count: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ModGalleryItem {
    url: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    description: Option<String>,
    featured: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ModDetail {
    source: String,
    id: String,
    slug: String,
    title: String,
    description: String,
    author: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    icon_url: Option<String>,
    downloads: i64,
    categories: Vec<String>,
    /// Полное описание: Markdown для Modrinth, HTML для CurseForge.
    body: String,
    /// `"markdown"` или `"html"`.
    body_format: String,
    gallery: Vec<ModGalleryItem>,
    followers: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    issues_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    source_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    wiki_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    discord_url: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct VersionsResult {
    versions: Vec<ModVersion>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ResolveResult {
    /// Лучшая подходящая версия или `None`, если подходящих нет.
    version: Option<ModVersion>,
}

// ───────────────────────── Валидация и мелочи ─────────────────────────

/// Пропускает только безопасные для подстановки в query-параметры значения.
/// Загрузчики и MC-версии у нас всегда простые (`neoforge`, `1.21.1`), но
/// значения приходят от клиента — без фильтра они попадали бы в facets-JSON.
fn sanitize_token(value: &str) -> Option<String> {
    let value = value.trim();
    if value.is_empty() || value.len() > 32 {
        return None;
    }
    value
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-' || c == '_')
        .then(|| value.to_string())
}

/// Валидация projectId/query: длиннее `sanitize_token` (до 128 символов),
/// допускает тот же набор символов. Modrinth slug бывает длиннее 32 символов,
/// поэтому для `project_id` отдельная проверка.
fn sanitize_project_id(value: &str) -> Option<String> {
    let value = value.trim();
    if value.is_empty() || value.len() > 128 {
        return None;
    }
    value
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '.' | '_'))
        .then(|| value.to_string())
}

/// Сопоставляет значение sort из UI с внутренним ключом сортировки.
/// `relevance` и пустое значение уходят как `None` — хостинги и так сортируют
/// по релевантности по умолчанию.
fn sanitize_sort(sort: Option<&str>) -> Option<String> {
    match sort.unwrap_or("").trim() {
        "downloads" => Some("downloads".to_string()),
        "newest" => Some("newest".to_string()),
        "updated" => Some("updated".to_string()),
        "follows" => Some("follows".to_string()),
        _ => None, // "relevance" = по умолчанию
    }
}

fn source_of(q: &str) -> Result<&'static str, ApiError> {
    match q.trim().to_ascii_lowercase().as_str() {
        "" | "modrinth" => Ok("modrinth"),
        "curseforge" => Ok("curseforge"),
        other => Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            format!("Неизвестный источник: {other}"),
        )),
    }
}

fn upstream_error(what: &str, e: impl std::fmt::Display) -> ApiError {
    ApiError::new(
        StatusCode::BAD_GATEWAY,
        format!("{what}: не удалось получить ответ ({e})"),
    )
}

fn check_status(resp: &reqwest::Response, what: &str) -> Result<(), ApiError> {
    if resp.status().is_success() {
        return Ok(());
    }
    Err(ApiError::new(
        StatusCode::BAD_GATEWAY,
        format!("{what}: хостинг вернул HTTP {}", resp.status().as_u16()),
    ))
}

// ───────────────────────── Modrinth ─────────────────────────

#[derive(Deserialize)]
struct MrSearch {
    #[serde(default)]
    hits: Vec<MrHit>,
    #[serde(default, rename = "total_hits")]
    total_hits: usize,
}

#[derive(Deserialize)]
struct MrHit {
    project_id: String,
    #[serde(default)]
    slug: String,
    title: String,
    #[serde(default)]
    description: String,
    #[serde(default)]
    author: String,
    #[serde(default)]
    icon_url: Option<String>,
    #[serde(default)]
    downloads: i64,
    #[serde(default)]
    display_categories: Vec<String>,
}

#[derive(Deserialize)]
struct MrVersion {
    id: String,
    #[serde(default)]
    name: String,
    #[serde(default)]
    version_number: String,
    #[serde(default)]
    version_type: String,
    #[serde(default)]
    date_published: Option<String>,
    #[serde(default)]
    downloads: i64,
    #[serde(default)]
    files: Vec<MrFile>,
    #[serde(default)]
    dependencies: Vec<MrDep>,
    /// `client_only` / `server_only` / `client_and_server` (у старых
    /// записей может отсутствовать).
    #[serde(default)]
    environment: Option<String>,
}

#[derive(Deserialize)]
struct MrFile {
    #[serde(default)]
    url: String,
    #[serde(default)]
    filename: String,
    #[serde(default)]
    primary: bool,
    #[serde(default)]
    size: i64,
}

#[derive(Deserialize)]
struct MrDep {
    #[serde(default)]
    project_id: Option<String>,
    #[serde(default)]
    version_id: Option<String>,
    #[serde(default)]
    dependency_type: String,
}

#[derive(Deserialize)]
struct MrProject {
    id: String,
    #[serde(default)]
    title: String,
}

/// Полный проект Modrinth для `/v2/project/{id}`.
#[derive(Deserialize)]
struct MrDetailedProject {
    id: String,
    #[serde(default)]
    slug: String,
    #[serde(default)]
    title: String,
    #[serde(default)]
    description: String,
    #[serde(default)]
    body: String,
    #[serde(default)]
    icon_url: Option<String>,
    #[serde(default)]
    downloads: i64,
    #[serde(default)]
    followers: i64,
    #[serde(default)]
    categories: Vec<String>,
    #[serde(default)]
    gallery: Vec<MrGalleryItem>,
    #[serde(default)]
    issues_url: Option<String>,
    #[serde(default)]
    source_url: Option<String>,
    #[serde(default)]
    wiki_url: Option<String>,
    #[serde(default)]
    discord_url: Option<String>,
}

#[derive(Deserialize)]
struct MrGalleryItem {
    url: String,
    #[serde(default)]
    featured: bool,
    #[serde(default)]
    title: Option<String>,
    #[serde(default)]
    description: Option<String>,
}

impl MrVersion {
    fn into_dto(self) -> ModVersion {
        // У версии бывает несколько файлов (sources, javadoc, dev). Берём
        // primary, иначе первый с URL — остальное админке не нужно.
        let file = self
            .files
            .iter()
            .find(|f| f.primary && !f.url.is_empty())
            .or_else(|| self.files.iter().find(|f| !f.url.is_empty()));
        let dependencies = self
            .dependencies
            .into_iter()
            .map(|d| ModDependency {
                project_id: d.project_id,
                version_id: d.version_id,
                dependency_type: d.dependency_type,
                title: None,
            })
            .collect();
        ModVersion {
            id: self.id,
            name: self.name,
            version_number: self.version_number,
            version_type: self.version_type,
            date_published: self.date_published,
            downloads: self.downloads,
            file_name: file.map(|f| f.filename.clone()).unwrap_or_default(),
            file_url: file.map(|f| f.url.clone()).filter(|u| !u.is_empty()),
            file_size: file.map(|f| f.size).unwrap_or(0),
            environment: self.environment.unwrap_or_else(|| "unknown".to_string()),
            dependencies,
        }
    }
}

fn modrinth_facets(
    loader: &Option<String>,
    mc_version: &Option<String>,
    categories: &Option<String>,
) -> String {
    let mut facets = vec!["[\"project_type:mod\"]".to_string()];
    if let Some(mc) = mc_version {
        facets.push(format!("[\"versions:{mc}\"]"));
    }
    if let Some(loader) = loader {
        facets.push(format!("[\"categories:{loader}\"]"));
    }
    if let Some(cats) = categories {
        for cat in cats.split(',') {
            let cat = cat.trim();
            if !cat.is_empty() {
                facets.push(format!("[\"categories:{cat}\"]"));
            }
        }
    }
    format!("[{}]", facets.join(","))
}

async fn modrinth_search(
    state: &Shared,
    query: &str,
    loader: Option<String>,
    mc_version: Option<String>,
    offset: usize,
    sort: Option<String>,
    categories: Option<String>,
) -> Result<(Vec<ModHit>, usize), ApiError> {
    // Маппинг сортировки в index-параметр Modrinth.
    let index = sort.as_deref().unwrap_or("relevance");
    let mut url = reqwest::Url::parse("https://api.modrinth.com/v2/search")
        .map_err(|e| upstream_error("Modrinth", e))?;
    {
        let mut pairs = url.query_pairs_mut();
        pairs.append_pair("query", query);
        pairs.append_pair("limit", &SEARCH_LIMIT.to_string());
        pairs.append_pair("offset", &offset.to_string());
        pairs.append_pair("index", index);
        pairs.append_pair("facets", &modrinth_facets(&loader, &mc_version, &categories));
    }
    let resp = state
        .http
        .get(url)
        .timeout(UPSTREAM_TIMEOUT)
        .send()
        .await
        .map_err(|e| upstream_error("Modrinth", e))?;
    check_status(&resp, "Modrinth")?;
    let parsed: MrSearch = resp
        .json()
        .await
        .map_err(|e| upstream_error("Modrinth", e))?;

    let total = parsed.total_hits;
    let hits = parsed
        .hits
        .into_iter()
        .map(|h| ModHit {
            source: "modrinth".to_string(),
            id: h.project_id,
            slug: h.slug,
            title: h.title,
            description: h.description,
            author: h.author,
            icon_url: h.icon_url,
            downloads: h.downloads,
            categories: h.display_categories,
        })
        .collect();
    Ok((hits, total))
}

async fn modrinth_versions(
    state: &Shared,
    project_id: &str,
    loader: Option<String>,
    mc_version: Option<String>,
) -> Result<Vec<ModVersion>, ApiError> {
    let mut url = reqwest::Url::parse(&format!(
        "https://api.modrinth.com/v2/project/{project_id}/version"
    ))
    .map_err(|e| upstream_error("Modrinth", e))?;
    {
        let mut pairs = url.query_pairs_mut();
        if let Some(loader) = &loader {
            pairs.append_pair("loaders", &format!("[\"{loader}\"]"));
        }
        if let Some(mc) = &mc_version {
            pairs.append_pair("game_versions", &format!("[\"{mc}\"]"));
        }
    }
    let resp = state
        .http
        .get(url)
        .timeout(UPSTREAM_TIMEOUT)
        .send()
        .await
        .map_err(|e| upstream_error("Modrinth", e))?;
    check_status(&resp, "Modrinth")?;
    let parsed: Vec<MrVersion> = resp
        .json()
        .await
        .map_err(|e| upstream_error("Modrinth", e))?;

    Ok(parsed
        .into_iter()
        .take(VERSIONS_LIMIT)
        .map(MrVersion::into_dto)
        .collect())
}

/// Подтягивает названия проектов-зависимостей одним запросом, чтобы в UI
/// было «Fabric API», а не `P7dR8mSH`.
async fn enrich_modrinth_dependency_titles(
    state: &Shared,
    versions: &mut [ModVersion],
) -> Result<(), ApiError> {
    let mut ids: Vec<String> = versions
        .iter()
        .flat_map(|v| v.dependencies.iter())
        .filter_map(|d| d.project_id.clone())
        .collect();
    ids.sort();
    ids.dedup();
    if ids.is_empty() {
        return Ok(());
    }
    let list = ids
        .iter()
        .map(|id| format!("\"{id}\""))
        .collect::<Vec<_>>()
        .join(",");
    let url = format!("https://api.modrinth.com/v2/projects?ids=[{list}]");
    let resp = match state.http.get(url).timeout(UPSTREAM_TIMEOUT).send().await {
        Ok(r) => r,
        // Названия — украшение: если справочник недоступен, зависимости
        // всё равно показываем по id.
        Err(_) => return Ok(()),
    };
    if !resp.status().is_success() {
        return Ok(());
    }
    let projects: Vec<MrProject> = match resp.json().await {
        Ok(p) => p,
        Err(_) => return Ok(()),
    };
    let titles: std::collections::HashMap<String, String> =
        projects.into_iter().map(|p| (p.id, p.title)).collect();
    for v in versions.iter_mut() {
        for d in v.dependencies.iter_mut() {
            if let Some(pid) = &d.project_id {
                d.title = titles.get(pid).cloned();
            }
        }
    }
    Ok(())
}

/// Запрашивает полные данные проекта Modrinth по id или slug.
async fn modrinth_detail(
    state: &Shared,
    project_id: &str,
) -> Result<ModDetail, ApiError> {
    let url = format!("https://api.modrinth.com/v2/project/{project_id}");
    let resp = state
        .http
        .get(&url)
        .timeout(UPSTREAM_TIMEOUT)
        .send()
        .await
        .map_err(|e| upstream_error("Modrinth", e))?;
    check_status(&resp, "Modrinth")?;
    let p: MrDetailedProject = resp.json().await.map_err(|e| upstream_error("Modrinth", e))?;
    Ok(ModDetail {
        source: "modrinth".to_string(),
        id: p.id,
        slug: p.slug,
        title: p.title,
        description: p.description,
        // Modrinth /v2/project/{id} не содержит имени автора — фронт берёт
        // его из результата поиска (ModHit). Оставляем пустым.
        author: String::new(),
        icon_url: p.icon_url,
        downloads: p.downloads,
        categories: p.categories,
        body: p.body,
        body_format: "markdown".to_string(),
        gallery: p
            .gallery
            .into_iter()
            .map(|g| ModGalleryItem {
                url: g.url,
                featured: g.featured,
                title: g.title,
                description: g.description,
            })
            .collect(),
        followers: p.followers,
        issues_url: p.issues_url,
        source_url: p.source_url,
        wiki_url: p.wiki_url,
        discord_url: p.discord_url,
    })
}

// ───────────────────────── CurseForge ─────────────────────────

/// CurseForge использует числовые коды загрузчиков.
fn curseforge_loader_type(loader: &str) -> Option<&'static str> {
    match loader.to_ascii_lowercase().as_str() {
        "forge" => Some("1"),
        "fabric" => Some("4"),
        "quilt" => Some("5"),
        "neoforge" => Some("6"),
        _ => None,
    }
}

#[derive(Deserialize)]
struct CfEnvelope<T> {
    data: T,
}

#[derive(Deserialize)]
struct CfLogo {
    #[serde(default)]
    url: Option<String>,
}

#[derive(Deserialize)]
struct CfAuthor {
    #[serde(default)]
    name: String,
}

#[derive(Deserialize)]
struct CfCategory {
    #[serde(default)]
    name: String,
}

#[derive(Deserialize)]
struct CfScreenshot {
    #[serde(default)]
    url: Option<String>,
    #[serde(default)]
    title: String,
    #[serde(default)]
    description: String,
}

#[derive(Deserialize)]
struct CfLinks {
    #[serde(rename = "issuesUrl", default)]
    issues_url: Option<String>,
    #[serde(rename = "sourceUrl", default)]
    source_url: Option<String>,
    #[serde(rename = "wikiUrl", default)]
    wiki_url: Option<String>,
}

#[derive(Deserialize)]
struct CfMod {
    id: i64,
    #[serde(default)]
    slug: String,
    #[serde(default)]
    name: String,
    #[serde(default)]
    summary: String,
    #[serde(default)]
    logo: Option<CfLogo>,
    #[serde(rename = "downloadCount", default)]
    download_count: i64,
    #[serde(default)]
    authors: Vec<CfAuthor>,
    #[serde(default)]
    categories: Vec<CfCategory>,
    #[serde(default)]
    screenshots: Vec<CfScreenshot>,
    #[serde(rename = "links", default)]
    links: Option<CfLinks>,
}

/// Пагинация в ответе CurseForge поиска.
#[derive(Deserialize)]
struct CfPagination {
    #[serde(rename = "totalCount", default)]
    total_count: usize,
}

#[derive(Deserialize)]
struct CfSearchResp {
    #[serde(default)]
    data: Vec<CfMod>,
    #[serde(default)]
    pagination: Option<CfPagination>,
}

#[derive(Deserialize)]
struct CfFile {
    id: i64,
    #[serde(rename = "displayName", default)]
    display_name: String,
    #[serde(rename = "fileName", default)]
    file_name: String,
    #[serde(rename = "fileDate", default)]
    file_date: Option<String>,
    #[serde(rename = "fileLength", default)]
    file_length: i64,
    #[serde(rename = "downloadCount", default)]
    download_count: i64,
    #[serde(rename = "downloadUrl", default)]
    download_url: Option<String>,
    /// 1 = release, 2 = beta, 3 = alpha.
    #[serde(rename = "releaseType", default)]
    release_type: i64,
    #[serde(default)]
    dependencies: Vec<CfDependency>,
}

#[derive(Deserialize)]
struct CfDependency {
    #[serde(rename = "modId", default)]
    mod_id: Option<i64>,
    /// 3 = required, 2 = optional, 1 = embedded, 5 = incompatible.
    #[serde(rename = "relationType", default)]
    relation_type: i64,
}

impl CfFile {
    fn into_dto(self) -> ModVersion {
        let version_type = match self.release_type {
            1 => "release",
            2 => "beta",
            3 => "alpha",
            _ => "release",
        };
        let dependencies = self
            .dependencies
            .into_iter()
            .map(|d| ModDependency {
                project_id: d.mod_id.map(|id| id.to_string()),
                version_id: None,
                dependency_type: match d.relation_type {
                    3 => "required",
                    2 => "optional",
                    1 => "embedded",
                    5 => "incompatible",
                    _ => "unknown",
                }
                .to_string(),
                title: None,
            })
            .collect();
        ModVersion {
            id: self.id.to_string(),
            name: if self.display_name.is_empty() {
                self.file_name.clone()
            } else {
                self.display_name
            },
            version_number: self.file_name.clone(),
            version_type: version_type.to_string(),
            date_published: self.file_date,
            downloads: self.download_count,
            file_name: self.file_name,
            file_url: self.download_url.filter(|u| !u.is_empty()),
            file_size: self.file_length,
            // CurseForge не отдаёт сторону по файлу в этом эндпоинте —
            // считаем «обе», админ уточнит в свойствах файла.
            environment: "unknown".to_string(),
            dependencies,
        }
    }
}

async fn curseforge_key(state: &Shared) -> Result<String, ApiError> {
    state
        .store
        .get_setting(SETTING_CURSEFORGE_API_KEY)
        .await
        .map_err(internal)?
        .map(|k| k.trim().to_string())
        .filter(|k| !k.is_empty())
        .ok_or_else(|| {
            ApiError::new(
                StatusCode::BAD_REQUEST,
                "CurseForge не настроен: добавьте API-ключ в настройках админки",
            )
        })
}

async fn curseforge_search(
    state: &Shared,
    query: &str,
    loader: Option<String>,
    mc_version: Option<String>,
    offset: usize,
    sort: Option<String>,
) -> Result<(Vec<ModHit>, usize), ApiError> {
    let key = curseforge_key(state).await?;
    let mut url = reqwest::Url::parse("https://api.curseforge.com/v1/mods/search")
        .map_err(|e| upstream_error("CurseForge", e))?;
    {
        let mut pairs = url.query_pairs_mut();
        pairs.append_pair("gameId", CURSEFORGE_GAME_ID);
        pairs.append_pair("classId", CURSEFORGE_CLASS_ID);
        pairs.append_pair("searchFilter", query);
        // Маппинг sort → числовой sortField CurseForge.
        // 2 = популярность (Popularity), 6 = загрузки, 3 = дата обновления, 1 = подписчики.
        let sort_field = match sort.as_deref().unwrap_or("") {
            "downloads" => "6",
            "newest" | "updated" => "3",
            "follows" => "1",
            _ => "2", // relevance → популярность
        };
        pairs.append_pair("sortField", sort_field);
        pairs.append_pair("sortOrder", "desc");
        pairs.append_pair("pageSize", &SEARCH_LIMIT.to_string());
        pairs.append_pair("index", &offset.to_string());
        if let Some(mc) = &mc_version {
            pairs.append_pair("gameVersion", mc);
        }
        if let Some(loader) = loader.as_deref().and_then(curseforge_loader_type) {
            pairs.append_pair("modLoaderType", loader);
        }
    }
    let resp = state
        .http
        .get(url)
        .header("x-api-key", key)
        .timeout(UPSTREAM_TIMEOUT)
        .send()
        .await
        .map_err(|e| upstream_error("CurseForge", e))?;
    check_status(&resp, "CurseForge")?;
    let parsed: CfSearchResp = resp
        .json()
        .await
        .map_err(|e| upstream_error("CurseForge", e))?;

    let total = parsed
        .pagination
        .map(|p| p.total_count)
        .unwrap_or(parsed.data.len());
    let hits = parsed
        .data
        .into_iter()
        .map(|m| ModHit {
            source: "curseforge".to_string(),
            id: m.id.to_string(),
            slug: m.slug,
            title: m.name,
            description: m.summary,
            author: m.authors.first().map(|a| a.name.clone()).unwrap_or_default(),
            icon_url: m.logo.and_then(|l| l.url),
            downloads: m.download_count,
            categories: m.categories.into_iter().map(|c| c.name).collect(),
        })
        .collect();
    Ok((hits, total))
}

async fn curseforge_versions(
    state: &Shared,
    project_id: &str,
    loader: Option<String>,
    mc_version: Option<String>,
) -> Result<Vec<ModVersion>, ApiError> {
    let key = curseforge_key(state).await?;
    let mut url = reqwest::Url::parse(&format!(
        "https://api.curseforge.com/v1/mods/{project_id}/files"
    ))
    .map_err(|e| upstream_error("CurseForge", e))?;
    {
        let mut pairs = url.query_pairs_mut();
        pairs.append_pair("pageSize", &VERSIONS_LIMIT.to_string());
        if let Some(mc) = &mc_version {
            pairs.append_pair("gameVersion", mc);
        }
        if let Some(loader) = loader.as_deref().and_then(curseforge_loader_type) {
            pairs.append_pair("modLoaderType", loader);
        }
    }
    let resp = state
        .http
        .get(url)
        .header("x-api-key", key)
        .timeout(UPSTREAM_TIMEOUT)
        .send()
        .await
        .map_err(|e| upstream_error("CurseForge", e))?;
    check_status(&resp, "CurseForge")?;
    let parsed: CfEnvelope<Vec<CfFile>> = resp
        .json()
        .await
        .map_err(|e| upstream_error("CurseForge", e))?;

    Ok(parsed
        .data
        .into_iter()
        .take(VERSIONS_LIMIT)
        .map(CfFile::into_dto)
        .collect())
}

/// Запрашивает полные данные мода CurseForge: основные поля + HTML-описание.
async fn curseforge_detail(
    state: &Shared,
    project_id: &str,
) -> Result<ModDetail, ApiError> {
    let key = curseforge_key(state).await?;

    // Получаем основные данные мода.
    let mod_resp = state
        .http
        .get(format!("https://api.curseforge.com/v1/mods/{project_id}"))
        .header("x-api-key", &key)
        .timeout(UPSTREAM_TIMEOUT)
        .send()
        .await
        .map_err(|e| upstream_error("CurseForge", e))?;
    check_status(&mod_resp, "CurseForge")?;
    let envelope: CfEnvelope<CfMod> = mod_resp
        .json()
        .await
        .map_err(|e| upstream_error("CurseForge", e))?;
    let m = envelope.data;

    // Получаем HTML-описание отдельным запросом.
    let desc_resp = state
        .http
        .get(format!(
            "https://api.curseforge.com/v1/mods/{project_id}/description"
        ))
        .header("x-api-key", &key)
        .timeout(UPSTREAM_TIMEOUT)
        .send()
        .await
        .map_err(|e| upstream_error("CurseForge", e))?;
    check_status(&desc_resp, "CurseForge")?;
    #[derive(Deserialize)]
    struct CfDesc {
        data: String,
    }
    let body = desc_resp
        .json::<CfDesc>()
        .await
        .map(|d| d.data)
        .unwrap_or_default();

    Ok(ModDetail {
        source: "curseforge".to_string(),
        id: m.id.to_string(),
        slug: m.slug.clone(),
        title: m.name.clone(),
        description: m.summary.clone(),
        author: m.authors.first().map(|a| a.name.clone()).unwrap_or_default(),
        icon_url: m.logo.and_then(|l| l.url),
        downloads: m.download_count,
        categories: m.categories.iter().map(|c| c.name.clone()).collect(),
        body,
        body_format: "html".to_string(),
        gallery: m
            .screenshots
            .into_iter()
            .filter_map(|s| {
                s.url.map(|url| ModGalleryItem {
                    url,
                    featured: false,
                    title: if s.title.is_empty() { None } else { Some(s.title) },
                    description: if s.description.is_empty() {
                        None
                    } else {
                        Some(s.description)
                    },
                })
            })
            .collect(),
        followers: 0,
        issues_url: m.links.as_ref().and_then(|l| l.issues_url.clone()),
        source_url: m.links.as_ref().and_then(|l| l.source_url.clone()),
        wiki_url: m.links.as_ref().and_then(|l| l.wiki_url.clone()),
        discord_url: None,
    })
}

// ───────────────────────── Резолв и обработчики ─────────────────────────

/// Берёт из списка лучшую версию: сначала release, потом любую. Список
/// хостинги отдают новыми сверху, поэтому первая подходящая — самая свежая.
fn pick_best(mut versions: Vec<ModVersion>) -> Option<ModVersion> {
    let release = versions
        .iter()
        .position(|v| v.version_type == "release" && v.file_url.is_some());
    match release {
        Some(idx) => Some(versions.remove(idx)),
        None => versions.into_iter().find(|v| v.file_url.is_some()),
    }
}

async fn versions_for(
    state: &Shared,
    source: &str,
    project_id: &str,
    loader: Option<String>,
    mc_version: Option<String>,
) -> Result<Vec<ModVersion>, ApiError> {
    let mut versions = match source {
        "curseforge" => curseforge_versions(state, project_id, loader, mc_version).await?,
        _ => modrinth_versions(state, project_id, loader, mc_version).await?,
    };
    if source == "modrinth" {
        enrich_modrinth_dependency_titles(state, &mut versions).await?;
    }
    Ok(versions)
}

/// `GET /api/mods/search?source=&query=&loader=&mcVersion=&offset=&sort=&categories=`
pub(crate) async fn search_mods(
    State(state): State<Shared>,
    headers: HeaderMap,
    Query(q): Query<SearchQuery>,
) -> Result<Json<SearchResult>, ApiError> {
    require_admin(&state, &headers).await?;
    let source = source_of(q.source.as_deref().unwrap_or(""))?;
    let query = q.query.unwrap_or_default().trim().to_string();
    // Пустой запрос — не ошибка: покажем популярное в этой версии/загрузчике.
    if query.len() > 120 {
        return Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            "Слишком длинный поисковый запрос",
        ));
    }
    let loader = q.loader.as_deref().and_then(sanitize_token);
    let mc_version = q.mc_version.as_deref().and_then(sanitize_token);
    let sort = sanitize_sort(q.sort.as_deref());
    let offset = q.offset;

    let (hits, total_count) = match source {
        "curseforge" => {
            curseforge_search(&state, &query, loader, mc_version, offset, sort).await?
        }
        _ => {
            modrinth_search(&state, &query, loader, mc_version, offset, sort, q.categories).await?
        }
    };
    Ok(Json(SearchResult { hits, total_count }))
}

/// `GET /api/mods/versions?source=&projectId=&loader=&mcVersion=`
pub(crate) async fn mod_versions(
    State(state): State<Shared>,
    headers: HeaderMap,
    Query(q): Query<VersionsQuery>,
) -> Result<Json<VersionsResult>, ApiError> {
    require_admin(&state, &headers).await?;
    let source = source_of(q.source.as_deref().unwrap_or(""))?;
    let project_id = sanitize_token(&q.project_id)
        .ok_or_else(|| ApiError::new(StatusCode::BAD_REQUEST, "Некорректный projectId"))?;
    let loader = q.loader.as_deref().and_then(sanitize_token);
    let mc_version = q.mc_version.as_deref().and_then(sanitize_token);

    let versions = versions_for(&state, source, &project_id, loader, mc_version).await?;
    Ok(Json(VersionsResult { versions }))
}

/// `GET /api/mods/resolve?...` — одна лучшая версия проекта. Нужен для
/// зависимостей: админка не выбирает их вручную, а ставит подходящую свежую.
pub(crate) async fn resolve_mod(
    State(state): State<Shared>,
    headers: HeaderMap,
    Query(q): Query<VersionsQuery>,
) -> Result<Json<ResolveResult>, ApiError> {
    require_admin(&state, &headers).await?;
    let source = source_of(q.source.as_deref().unwrap_or(""))?;
    let project_id = sanitize_token(&q.project_id)
        .ok_or_else(|| ApiError::new(StatusCode::BAD_REQUEST, "Некорректный projectId"))?;
    let loader = q.loader.as_deref().and_then(sanitize_token);
    let mc_version = q.mc_version.as_deref().and_then(sanitize_token);

    let versions = versions_for(&state, source, &project_id, loader, mc_version).await?;
    Ok(Json(ResolveResult {
        version: pick_best(versions),
    }))
}

/// `GET /api/mods/detail?source=&projectId=` — полные данные проекта для карточки мода.
pub(crate) async fn mod_detail(
    State(state): State<Shared>,
    headers: HeaderMap,
    Query(q): Query<DetailQuery>,
) -> Result<Json<ModDetail>, ApiError> {
    require_admin(&state, &headers).await?;
    let project_id = sanitize_project_id(&q.project_id).ok_or_else(|| {
        ApiError::new(StatusCode::BAD_REQUEST, "Некорректный projectId")
    })?;
    let source = source_of(q.source.as_deref().unwrap_or(""))?;
    let detail = match source {
        "modrinth" => modrinth_detail(&state, &project_id).await?,
        "curseforge" => curseforge_detail(&state, &project_id).await?,
        _ => unreachable!(),
    };
    Ok(Json(detail))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitize_token_keeps_versions_and_rejects_injection() {
        assert_eq!(sanitize_token("1.21.1"), Some("1.21.1".to_string()));
        assert_eq!(sanitize_token("neoforge"), Some("neoforge".to_string()));
        assert_eq!(sanitize_token("  1.20  "), Some("1.20".to_string()));
        assert_eq!(sanitize_token("1.21\"]}"), None);
        assert_eq!(sanitize_token(""), None);
    }

    #[test]
    fn modrinth_facets_include_loader_and_version() {
        let facets = modrinth_facets(&Some("neoforge".to_string()), &Some("1.21.1".to_string()), &None);
        assert!(facets.contains("project_type:mod"));
        assert!(facets.contains("versions:1.21.1"));
        assert!(facets.contains("categories:neoforge"));
    }

    #[test]
    fn curseforge_loader_codes_match_api() {
        assert_eq!(curseforge_loader_type("neoforge"), Some("6"));
        assert_eq!(curseforge_loader_type("forge"), Some("1"));
        assert_eq!(curseforge_loader_type("fabric"), Some("4"));
        assert_eq!(curseforge_loader_type("quilt"), Some("5"));
        assert_eq!(curseforge_loader_type("vanilla"), None);
    }

    #[test]
    fn pick_best_prefers_release_over_newer_beta() {
        let mk = |id: &str, kind: &str, url: Option<&str>| ModVersion {
            id: id.to_string(),
            name: String::new(),
            version_number: String::new(),
            version_type: kind.to_string(),
            date_published: None,
            downloads: 0,
            file_name: String::new(),
            file_url: url.map(|u| u.to_string()),
            file_size: 0,
            environment: "unknown".to_string(),
            dependencies: Vec::new(),
        };
        let versions = vec![
            mk("beta", "beta", Some("https://cdn.modrinth.com/b.jar")),
            mk("release", "release", Some("https://cdn.modrinth.com/r.jar")),
            mk("old", "release", Some("https://cdn.modrinth.com/o.jar")),
        ];
        let best = pick_best(versions).unwrap();
        assert_eq!(best.id, "release");

        let no_release = vec![mk("a", "alpha", None), mk("b", "beta", Some("u"))];
        assert_eq!(pick_best(no_release).unwrap().id, "b");
    }
}
