//! Клиент Mojang: импорт скина с лицензионного аккаунта по нику или UUID.
//!
//! Поток:
//! 1. Если `source` — ник, резолвим его в UUID через api.mojang.com.
//! 2. По UUID запрашиваем профиль на sessionserver.mojang.com.
//! 3. В профиле есть property `textures` (base64-JSON) с URL скина и моделью.
//! 4. Скачиваем PNG по этому URL.

use base64::Engine;
use serde::Deserialize;

use protocol::SkinModel;

/// Результат импорта: байты PNG, модель и нормализованный UUID-источник.
pub struct ImportedSkin {
    pub png: Vec<u8>,
    pub model: SkinModel,
    /// PNG плаща, если он есть у лицензионного аккаунта.
    pub cape_png: Option<Vec<u8>>,
    /// UUID Mojang без дефисов — используется как ключ синхронизации.
    pub source_uuid: String,
}

#[derive(Debug)]
pub enum MojangError {
    NotFound,
    NoSkin,
    Network(String),
}

impl std::fmt::Display for MojangError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            MojangError::NotFound => write!(f, "аккаунт Mojang не найден"),
            MojangError::NoSkin => write!(f, "у аккаунта нет скина"),
            MojangError::Network(e) => write!(f, "ошибка сети: {e}"),
        }
    }
}

#[derive(Deserialize)]
struct NameToUuid {
    id: String,
}

#[derive(Deserialize)]
struct ProfileResponse {
    properties: Vec<ProfileProperty>,
}

#[derive(Deserialize)]
struct ProfileProperty {
    name: String,
    value: String,
}

#[derive(Deserialize)]
struct TexturesPayload {
    textures: Textures,
}

#[derive(Deserialize)]
struct Textures {
    #[serde(rename = "SKIN")]
    skin: Option<SkinTexture>,
    #[serde(rename = "CAPE")]
    cape: Option<CapeTexture>,
}

#[derive(Deserialize)]
struct CapeTexture {
    url: String,
}

#[derive(Deserialize)]
struct SkinTexture {
    url: String,
    #[serde(default)]
    metadata: Option<SkinMetadata>,
}

#[derive(Deserialize)]
struct SkinMetadata {
    model: Option<String>,
}

/// Является ли строка UUID (32 hex без дефисов или 36 с дефисами).
fn looks_like_uuid(s: &str) -> bool {
    let stripped = s.replace('-', "");
    stripped.len() == 32 && stripped.chars().all(|c| c.is_ascii_hexdigit())
}

/// Импортирует скин с Mojang по нику или UUID.
pub async fn import_skin(
    client: &reqwest::Client,
    source: &str,
) -> Result<ImportedSkin, MojangError> {
    let uuid = if looks_like_uuid(source) {
        source.replace('-', "").to_lowercase()
    } else {
        resolve_name(client, source).await?
    };

    let profile_url = format!("https://sessionserver.mojang.com/session/minecraft/profile/{uuid}");
    let resp = client
        .get(&profile_url)
        .send()
        .await
        .map_err(|e| MojangError::Network(e.to_string()))?;

    if resp.status() == reqwest::StatusCode::NO_CONTENT || resp.status() == 404 {
        return Err(MojangError::NotFound);
    }
    let profile: ProfileResponse = resp
        .json()
        .await
        .map_err(|e| MojangError::Network(e.to_string()))?;

    let textures_b64 = profile
        .properties
        .into_iter()
        .find(|p| p.name == "textures")
        .ok_or(MojangError::NoSkin)?
        .value;

    let decoded = base64::engine::general_purpose::STANDARD
        .decode(textures_b64.as_bytes())
        .map_err(|e| MojangError::Network(e.to_string()))?;
    let payload: TexturesPayload =
        serde_json::from_slice(&decoded).map_err(|e| MojangError::Network(e.to_string()))?;

    let skin = payload.textures.skin.ok_or(MojangError::NoSkin)?;
    let model = match skin.metadata.and_then(|m| m.model).as_deref() {
        Some("slim") => SkinModel::Slim,
        _ => SkinModel::Classic,
    };

    let png = download_png(client, &skin.url).await?;

    // Плащ опционален: его отсутствие — не ошибка.
    let cape_png = match payload.textures.cape {
        Some(cape) => Some(download_png(client, &cape.url).await?),
        None => None,
    };

    Ok(ImportedSkin {
        png,
        model,
        cape_png,
        source_uuid: uuid,
    })
}

/// Скачивает PNG по URL текстуры Mojang.
async fn download_png(client: &reqwest::Client, url: &str) -> Result<Vec<u8>, MojangError> {
    Ok(client
        .get(url)
        .send()
        .await
        .map_err(|e| MojangError::Network(e.to_string()))?
        .bytes()
        .await
        .map_err(|e| MojangError::Network(e.to_string()))?
        .to_vec())
}

/// Резолвит ник Mojang в UUID без дефисов.
async fn resolve_name(client: &reqwest::Client, name: &str) -> Result<String, MojangError> {
    let url = format!("https://api.mojang.com/users/profiles/minecraft/{name}");
    let resp = client
        .get(&url)
        .send()
        .await
        .map_err(|e| MojangError::Network(e.to_string()))?;
    if resp.status() == reqwest::StatusCode::NO_CONTENT || resp.status() == 404 {
        return Err(MojangError::NotFound);
    }
    let parsed: NameToUuid = resp
        .json()
        .await
        .map_err(|e| MojangError::Network(e.to_string()))?;
    Ok(parsed.id.replace('-', "").to_lowercase())
}
