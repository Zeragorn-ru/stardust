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

use time::{format_description::well_known::Rfc3339, Duration, OffsetDateTime};

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
    /// Загружает ключ из PEM-файла; если файла нет — генерирует новый и
    /// сохраняет. Ошибки чтения/парса существующего ключа — фатальны.
    ///
    /// Почему fail hard: «тихий откат» на свежий ключ мгновенно протухал ВСЕ
    /// ранее выданные подписи (текстуры, profile_key-сертификаты чата), а
    /// перезапись поверх того же пути делала ротацию перманентной — битый
    /// PEM (обрыв записи при краше) навсегда заменялся новым ключом.
    /// Перезапуск контейнера с алертом в логе лучше необратимой потери.
    pub fn load_or_generate(path: &Path) -> Result<Self, String> {
        match std::fs::read_to_string(path) {
            Ok(pem) => {
                let key = RsaPrivateKey::from_pkcs8_pem(&pem).map_err(|e| {
                    format!(
                        "не удалось разобрать ключ {}: {e}; файл повреждён? \
                         Перезапись молча ротировала бы ключ — восстановите файл                          из бэкапа или удалите осознанно",
                        path.display()
                    )
                })?;
                // Чиним права и у существующего файла: старые записи могли
                // быть созданы с 0644 — приватный ключ читался всей машиной.
                #[cfg(unix)]
                {
                    use std::os::unix::fs::PermissionsExt;
                    let _ = std::fs::set_permissions(
                        path,
                        std::fs::Permissions::from_mode(0o600),
                    );
                }
                Ok(Self::from_private(key))
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                // Файла нет — штатная первичная генерация.
                let key = Self::generate_private();
                let pem = key
                    .to_pkcs8_pem(LineEnding::LF)
                    .map_err(|e| format!("не удалось сериализовать ключ: {e}"))?;
                if let Some(parent) = path.parent() {
                    std::fs::create_dir_all(parent)
                        .map_err(|e| format!("не удалось создать каталог {}: {e}", parent.display()))?;
                }
                // Атомарная запись (tmp + rename): fs::write с O_TRUNC при
                // краше посреди записи оставлял пустой/усечённый PEM, и
                // следующий старт считал бы его битым.
                let tmp = path.with_extension("pem.tmp");
                #[cfg(unix)]
                {
                    use std::os::unix::fs::OpenOptionsExt;
                    use std::io::Write;
                    let mut file = std::fs::OpenOptions::new()
                        .write(true)
                        .create(true)
                        .truncate(true)
                        .mode(0o600)
                        .open(&tmp)
                        .map_err(|e| format!("не удалось создать {}: {e}", tmp.display()))?;
                    file.write_all(pem.as_bytes())
                        .map_err(|e| format!("не удалось записать {}: {e}", tmp.display()))?;
                    file.sync_all().map_err(|e| format!("fsync {}: {e}", tmp.display()))?;
                }
                #[cfg(not(unix))]
                {
                    std::fs::write(&tmp, pem.as_bytes())
                        .map_err(|e| format!("не удалось записать {}: {e}", tmp.display()))?;
                }
                std::fs::rename(&tmp, path).map_err(|e| {
                    format!("не удалось переименовать {} в {}: {e}", tmp.display(), path.display())
                })?;
                tracing::info!(
                    "сгенерирован новый ключ подписи Yggdrasil: {}",
                    path.display()
                );
                Ok(Self::from_private(key))
            }
            Err(e) => Err(format!(
                "не удалось прочитать ключ {}: {e} (продолжение молча                  ротировало бы ключ — почините права/диск)",
                path.display()
            )),
        }
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

fn pem_block(label: &str, der: &[u8]) -> String {
    let encoded = base64::engine::general_purpose::STANDARD.encode(der);
    let body = encoded
        .as_bytes()
        .chunks(76)
        .map(|line| std::str::from_utf8(line).expect("base64 is ASCII"))
        .collect::<Vec<_>>()
        .join("\n");
    format!("-----BEGIN {label}-----\n{body}\n-----END {label}-----\n")
}

/// Ответ Minecraft на `/minecraftservices/player/certificates`.
///
/// Authlib-injector получает этот ответ локально и передаёт ключевую пару
/// клиенту. Подписи делаются тем же RSA-ключом, который опубликован в
/// `signaturePublickey` метаданных Yggdrasil. Поэтому клиент и Paper видят
/// полноценную 2048-битную подпись вместо фиктивного `AA==` от upstream
/// authlib-injector.
pub fn profile_key_response(keys: &Keys, profile_id: &str) -> Option<serde_json::Value> {
    let compact_id = profile_id.replace('-', "");
    let canonical_id = if compact_id.len() == 32 {
        format!(
            "{}-{}-{}-{}-{}",
            &compact_id[0..8],
            &compact_id[8..12],
            &compact_id[12..16],
            &compact_id[16..20],
            &compact_id[20..32]
        )
    } else {
        profile_id.to_string()
    };
    let profile_id = uuid::Uuid::parse_str(&canonical_id).ok()?;
    let mut rng = rand::thread_rng();
    let private_key = RsaPrivateKey::new(&mut rng, KEY_BITS).ok()?;
    let public_key = private_key.to_public_key();
    let private_der = private_key.to_pkcs8_der().ok()?;
    let public_der = public_key.to_public_key_der().ok()?;
    // Minecraft's certificate parser accepts PKCS#8/PKIX DER with the
    // historical RSA PEM labels used by the Mojang endpoint.
    let private_pem = pem_block("RSA PRIVATE KEY", private_der.as_bytes());
    let public_pem = pem_block("RSA PUBLIC KEY", public_der.as_bytes());

    let now = OffsetDateTime::now_utc();
    let expires_at = now + Duration::hours(48);
    let refreshed_after = now + Duration::hours(36);
    let expires_ms = expires_at.unix_timestamp_nanos() / 1_000_000;
    let expires_ms = i64::try_from(expires_ms).ok()?;

    // Legacy certificate signature: decimal expiry followed by the PEM key.
    let legacy_payload = format!("{expires_ms}{public_pem}");
    let legacy_signature = keys.sign(legacy_payload.as_bytes());

    // Modern certificate signature: fixed-width UUID + expiry (big-endian)
    // + DER key. Minecraft's ProfilePublicKey.Data writes both UUID longs,
    // including leading zero bytes.
    let mut v2_payload = Vec::with_capacity(16 + 8 + public_der.as_bytes().len());
    v2_payload.extend_from_slice(profile_id.as_bytes());
    v2_payload.extend_from_slice(&expires_ms.to_be_bytes());
    v2_payload.extend_from_slice(public_der.as_bytes());
    let v2_signature = keys.sign(&v2_payload);

    Some(serde_json::json!({
        "keyPair": {
            "privateKey": private_pem,
            "publicKey": public_pem,
        },
        "publicKeySignature": legacy_signature,
        "publicKeySignatureV2": v2_signature,
        "expiresAt": expires_at.format(&Rfc3339).ok()?,
        "refreshedAfter": refreshed_after.format(&Rfc3339).ok()?,
    }))
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

#[cfg(test)]
mod tests {
    use super::*;
    use rsa::pkcs1v15::{Signature, VerifyingKey};
    use rsa::signature::Verifier;

    fn verify(label: &str, verifier: &VerifyingKey<Sha1>, encoded: &str, payload: &[u8]) {
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(encoded)
            .expect("signature is base64");
        assert_eq!(bytes.len(), KEY_BITS / 8);
        verifier
            .verify(
                payload,
                &Signature::try_from(bytes.as_slice()).expect("RSA signature"),
            )
            .unwrap_or_else(|_| panic!("{label} signature must verify"));
    }

    #[test]
    fn profile_key_response_contains_verifiable_rsa_signatures() {
        let private = Keys::generate_private();
        let public = private.to_public_key();
        let verifier = VerifyingKey::<Sha1>::new(public.clone());
        let keys = Keys::from_private(private);
        let response = profile_key_response(&keys, "00112233445566778899aabbccddeeff")
            .expect("valid UUID should produce a certificate");

        let expires_at = response["expiresAt"].as_str().expect("expiry is a string");
        let expires_at = OffsetDateTime::parse(expires_at, &Rfc3339).expect("valid expiry");
        let expires_ms = expires_at.unix_timestamp_nanos() / 1_000_000;
        let expires_ms = i64::try_from(expires_ms).expect("expiry fits i64");
        let public_pem = response["keyPair"]["publicKey"]
            .as_str()
            .expect("public key is a string");
        let public_b64 = public_pem
            .lines()
            .filter(|line| !line.starts_with("-----"))
            .collect::<String>();
        let public_der = base64::engine::general_purpose::STANDARD
            .decode(public_b64)
            .expect("certificate public DER");

        let legacy_payload = format!("{expires_ms}{public_pem}");
        verify(
            "legacy",
            &verifier,
            response["publicKeySignature"]
                .as_str()
                .expect("legacy signature"),
            legacy_payload.as_bytes(),
        );

        let mut v2_payload = Vec::with_capacity(24 + public_der.len());
        v2_payload.extend_from_slice(
            &uuid::Uuid::parse_str("00112233-4455-6677-8899-aabbccddeeff")
                .expect("UUID")
                .as_bytes()[..],
        );
        v2_payload.extend_from_slice(&expires_ms.to_be_bytes());
        v2_payload.extend_from_slice(&public_der);
        verify(
            "v2",
            &verifier,
            response["publicKeySignatureV2"]
                .as_str()
                .expect("v2 signature"),
            &v2_payload,
        );
    }
}
