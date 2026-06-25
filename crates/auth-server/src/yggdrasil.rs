//! Yggdrasil-слой для authlib-injector.
//!
//! Здесь живёт криптография (ключ подписи профилей) и сборка JSON-структур
//! в формате Yggdrasil: метаданные API, сериализация профиля с текстурами и
//! цифровой подписью. Сами HTTP-маршруты — в `main.rs`.
//!
//! Формат и алгоритмы соответствуют спецификации authlib-injector:
//! подпись свойства профиля — SHA1withRSA (PKCS#1 v1.5), публичный ключ
//! отдаётся в PEM (SubjectPublicKeyInfo).

use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

use base64::Engine;
use rsa::pkcs1v15::SigningKey;
use rsa::pkcs8::{DecodePrivateKey, EncodePrivateKey, EncodePublicKey, LineEnding};
use rsa::signature::{SignatureEncoding, Signer};
use rsa::RsaPrivateKey;
use serde_json::json;
use sha1::Sha1;

use protocol::{PlayerProfile, SkinModel};

/// Размер ключа подписи. 2048 бит — стандарт Mojang/Yggdrasil.
const KEY_BITS: usize = 2048;

/// Ключ подписи профилей Yggdrasil.
///
/// Публичный ключ (PEM) попадает в метаданные API; authlib-injector проверяет
/// им подпись свойства `textures`. Приватный ключ персистится на диск, чтобы
/// он не менялся между перезапусками (иначе закэшированные клиентом подписи
/// перестанут проходить проверку).
pub struct Keys {
    signing: SigningKey<Sha1>,
    public_pem: String,
}

impl Keys {
    /// Загружает ключ из PEM-файла или генерирует новый и сохраняет его.
    ///
    /// При ошибке чтения/записи файла откатывается на эфемерный ключ в памяти,
    /// чтобы сервер всё равно поднялся (с предупреждением в лог).
    pub fn load_or_generate(path: &Path) -> Self {
        if let Ok(pem) = std::fs::read_to_string(path) {
            match RsaPrivateKey::from_pkcs8_pem(&pem) {
                Ok(key) => return Self::from_private(key),
                Err(e) => tracing::warn!("не удалось разобрать ключ {}: {e}", path.display()),
            }
        }

        let key = Self::generate_private();
        match key.to_pkcs8_pem(LineEnding::LF) {
            Ok(pem) => {
                if let Some(parent) = path.parent() {
                    let _ = std::fs::create_dir_all(parent);
                }
                if let Err(e) = std::fs::write(path, pem.as_bytes()) {
                    tracing::warn!("не удалось сохранить ключ {}: {e}", path.display());
                } else {
                    tracing::info!(
                        "сгенерирован новый ключ подписи Yggdrasil: {}",
                        path.display()
                    );
                }
            }
            Err(e) => tracing::warn!("не удалось сериализовать ключ подписи: {e}"),
        }
        Self::from_private(key)
    }

    fn generate_private() -> RsaPrivateKey {
        let mut rng = rand::thread_rng();
        RsaPrivateKey::new(&mut rng, KEY_BITS).expect("не удалось сгенерировать RSA-ключ")
    }

    fn from_private(key: RsaPrivateKey) -> Self {
        let public_pem = key
            .to_public_key()
            .to_public_key_pem(LineEnding::LF)
            .expect("не удалось сериализовать публичный ключ");
        Self {
            signing: SigningKey::<Sha1>::new(key),
            public_pem,
        }
    }

    /// Публичный ключ в PEM для метаданных API (`signaturePublickey`).
    pub fn public_pem(&self) -> &str {
        &self.public_pem
    }

    /// Подпись произвольных байтов (SHA1withRSA), результат в base64.
    pub fn sign(&self, data: &[u8]) -> String {
        let signature = self.signing.sign(data);
        base64::engine::general_purpose::STANDARD.encode(signature.to_bytes())
    }
}

/// Свойство профиля `textures`: возвращает (значение base64, подпись base64).
///
/// `skin_url` / `cape_url` — абсолютные URL вида `<public>/textures/<sha256>`.
pub fn textures_property(
    keys: &Keys,
    profile: &PlayerProfile,
    skin_url: Option<&str>,
    cape_url: Option<&str>,
    model: SkinModel,
) -> (String, String) {
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);

    let mut textures = serde_json::Map::new();
    if let Some(url) = skin_url {
        let skin = match model {
            SkinModel::Slim => json!({ "url": url, "metadata": { "model": "slim" } }),
            SkinModel::Classic => json!({ "url": url }),
        };
        textures.insert("SKIN".to_string(), skin);
    }
    if let Some(url) = cape_url {
        textures.insert("CAPE".to_string(), json!({ "url": url }));
    }

    let value = json!({
        "timestamp": timestamp,
        "profileId": profile.id,
        "profileName": profile.name,
        "textures": textures,
    });
    let encoded = base64::engine::general_purpose::STANDARD.encode(value.to_string().as_bytes());
    let signature = keys.sign(encoded.as_bytes());
    (encoded, signature)
}

/// Полная сериализация профиля Yggdrasil с атрибутами и подписью.
///
/// Если `with_textures` — `false`, отдаётся «лёгкий» профиль без `properties`
/// (для `/api/profiles/minecraft`). Если `signed` — `false`, подпись свойства
/// опускается (`?unsigned=true`, поведение по умолчанию).
pub fn profile_json(
    keys: &Keys,
    profile: &PlayerProfile,
    skin_url: Option<&str>,
    cape_url: Option<&str>,
    model: SkinModel,
    with_textures: bool,
    signed: bool,
) -> serde_json::Value {
    if !with_textures {
        return json!({ "id": profile.id, "name": profile.name });
    }

    let (value, signature) = textures_property(keys, profile, skin_url, cape_url, model);
    let mut property = serde_json::Map::new();
    property.insert("name".to_string(), json!("textures"));
    property.insert("value".to_string(), json!(value));
    if signed {
        property.insert("signature".to_string(), json!(signature));
    }

    json!({
        "id": profile.id,
        "name": profile.name,
        "properties": [property],
    })
}
