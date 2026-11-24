//! Программные API-токены для машинного доступа к админке (MCP/скрипты).
//!
//! Пароль админа и веб-сессия для машин не годятся: у сессии короткий TTL,
//! обязательный второй фактор и семантика logout. Здесь — отдельные токены,
//! привязанные к аккаунту админа: в БД лежит только SHA-256 хеш, полный
//! токен показывается один раз при создании. Сравнение хешей — в постоянном
//! времени (`constant_time_eq`), как у сессий.

use rand::RngCore;
use sha2::{Digest, Sha256};
use sqlx::Row;
use time::OffsetDateTime;

use crate::{constant_time_eq, format_timestamp, normalize_uuid, to_hex, Store, StoreError};

/// Префикс токена: помогает отличить API-токен от сессионного в логах и
/// исключает случайное использование короткой строки.
pub const API_TOKEN_PREFIX: &str = "sd_";

/// Сколько байт энтропии у токена (дальше — hex, 64 символа).
const API_TOKEN_BYTES: usize = 32;

/// Максимальная длина предъявленного токена, которую вообще хешируем:
/// защита от мусорных многомегабайтных заголовков.
const MAX_PRESENTED_TOKEN_LEN: usize = 256;

/// Отметка использования обновляется не чаще раза в минуту, чтобы каждый
/// запрос агента не превращался в лишний UPDATE.
const LAST_USED_THROTTLE_SECS: i64 = 60;

/// Строка токена для админки/аудита (без самого секрета).
#[derive(Debug, Clone)]
pub struct ApiTokenRow {
    pub id: i64,
    pub account_uuid: String,
    /// Ник владельца (JOIN; только в списке).
    pub username: String,
    pub name: String,
    /// Первые символы токена («sd_1a2b3c4d») — для списка и логов.
    pub token_prefix: String,
    pub created_at: String,
    pub last_used_at: Option<String>,
    pub revoked_at: Option<String>,
    pub expires_at: Option<String>,
}

/// Результат проверки токена: кто и каким токеном.
#[derive(Debug, Clone)]
pub struct ApiTokenOwner {
    pub token_id: i64,
    pub account_uuid: String,
}

/// Запись аудита программной операции. Токен сюда не попадает никогда —
/// только его id и владелец.
#[derive(Debug, Clone)]
pub struct ApiAuditEntry {
    pub token_id: Option<i64>,
    pub account_uuid: String,
    pub action: String,
    pub build_id: Option<i64>,
    pub file_id: Option<i64>,
    pub sha1: Option<String>,
    pub path: Option<String>,
    /// Код ошибки/детали операции; секретов здесь быть не должно.
    pub detail: Option<String>,
}

impl ApiAuditEntry {
    /// Пустая запись действия: владельца и id токена подставит вызывающий
    /// (см. `api_v1::audit`).
    pub fn action(action: &str) -> Self {
        Self {
            token_id: None,
            account_uuid: String::new(),
            action: action.to_string(),
            build_id: None,
            file_id: None,
            sha1: None,
            path: None,
            detail: None,
        }
    }
}

/// Генерирует новый токен: `sd_` + 64 hex-символа (32 случайных байта).
pub fn generate_api_token() -> String {
    let mut bytes = [0u8; API_TOKEN_BYTES];
    rand::thread_rng().fill_bytes(&mut bytes);
    format!("{API_TOKEN_PREFIX}{}", to_hex(&bytes))
}

/// SHA-256 (hex) токена — ровно то, что лежит в БД.
pub fn hash_api_token(token: &str) -> String {
    to_hex(&Sha256::digest(token.as_bytes()))
}

/// Сверяет предъявленный токен с хранимым хешем в постоянном времени.
pub fn api_token_matches(token: &str, stored_hash: &str) -> bool {
    constant_time_eq(hash_api_token(token).as_bytes(), stored_hash.as_bytes())
}

/// Короткий префикс для списка/логов: `sd_` и 8 hex-символов.
pub fn token_prefix(token: &str) -> String {
    token.chars().take(API_TOKEN_PREFIX.len() + 8).collect()
}

fn optional_timestamp(value: Option<OffsetDateTime>) -> Option<String> {
    value.map(format_timestamp)
}

const TOKEN_COLUMNS: &str = "t.id, t.account_uuid, a.username, t.name, t.token_prefix, \
     t.created_at, t.last_used_at, t.revoked_at, t.expires_at";

fn row_to_token(row: &sqlx::postgres::PgRow) -> ApiTokenRow {
    ApiTokenRow {
        id: row.get("id"),
        account_uuid: row.get("account_uuid"),
        username: row.get("username"),
        name: row.get("name"),
        token_prefix: row.get("token_prefix"),
        created_at: format_timestamp(row.get("created_at")),
        last_used_at: optional_timestamp(row.get("last_used_at")),
        revoked_at: optional_timestamp(row.get("revoked_at")),
        expires_at: optional_timestamp(row.get("expires_at")),
    }
}

impl Store {
    /// Создаёт токен и возвращает его полное значение (единственный раз) и
    /// строку для списка.
    pub async fn create_api_token(
        &self,
        account_uuid: &str,
        name: &str,
        expires_at: Option<OffsetDateTime>,
    ) -> Result<(String, ApiTokenRow), StoreError> {
        let token = generate_api_token();
        let token_hash = hash_api_token(&token);
        let prefix = token_prefix(&token);
        let sql = format!(
            "WITH inserted AS (
                INSERT INTO admin_api_tokens
                    (account_uuid, name, token_hash, token_prefix, expires_at)
                VALUES ($1, $2, $3, $4, $5)
                RETURNING id, account_uuid, name, token_prefix, created_at,
                          last_used_at, revoked_at, expires_at
             )
             SELECT {TOKEN_COLUMNS} FROM inserted t
             JOIN accounts a ON a.uuid = t.account_uuid"
        );
        let row = sqlx::query(&sql)
            .bind(normalize_uuid(account_uuid))
            .bind(name)
            .bind(&token_hash)
            .bind(&prefix)
            .bind(expires_at)
            .fetch_one(self.pool())
            .await?;
        Ok((token, row_to_token(&row)))
    }

    /// Создаёт токен из заранее заданного значения (bootstrap из env, без
    /// вывода секрета в логи). Идемпотентно: если хеш уже есть, ничего не
    /// делает и возвращает `false`. Значение обязано быть непустым.
    pub async fn create_api_token_with_value(
        &self,
        account_uuid: &str,
        name: &str,
        token: &str,
    ) -> Result<bool, StoreError> {
        if token.is_empty() {
            return Err(StoreError::Backend("пустой bootstrap-токен".into()));
        }
        let token_hash = hash_api_token(token);
        let prefix = token_prefix(token);
        let inserted = sqlx::query(
            "INSERT INTO admin_api_tokens (account_uuid, name, token_hash, token_prefix)
             VALUES ($1, $2, $3, $4)
             ON CONFLICT (token_hash) DO NOTHING",
        )
        .bind(normalize_uuid(account_uuid))
        .bind(name)
        .bind(&token_hash)
        .bind(&prefix)
        .execute(self.pool())
        .await?
        .rows_affected()
            > 0;
        Ok(inserted)
    }

    /// Все токены (включая отозванные/истёкшие) — для админки. Полные
    /// значения токенов здесь недоступны: в БД их нет.
    pub async fn list_api_tokens(&self) -> Result<Vec<ApiTokenRow>, StoreError> {
        let sql = format!(
            "SELECT {TOKEN_COLUMNS}
             FROM admin_api_tokens t
             JOIN accounts a ON a.uuid = t.account_uuid
             ORDER BY t.id DESC
             LIMIT 500"
        );
        let rows = sqlx::query(&sql).fetch_all(self.pool()).await?;
        Ok(rows.iter().map(row_to_token).collect())
    }

    /// Отзывает токен. Идемпотентно: повторный отзыв сохраняет исходное
    /// время `revoked_at`. `NotFound` — только если такого id нет вовсе.
    pub async fn revoke_api_token(&self, id: i64) -> Result<(), StoreError> {
        let changed = sqlx::query(
            "UPDATE admin_api_tokens
             SET revoked_at = COALESCE(revoked_at, now())
             WHERE id = $1",
        )
        .bind(id)
        .execute(self.pool())
        .await?
        .rows_affected();
        if changed == 0 {
            return Err(StoreError::NotFound);
        }
        Ok(())
    }

    /// Проверяет API-токен: жив, не отозван, не истёк. При успехе обновляет
    /// `last_used_at` (не чаще раза в минуту) и возвращает владельца.
    pub async fn validate_api_token(&self, token: &str) -> Option<ApiTokenOwner> {
        if token.len() > MAX_PRESENTED_TOKEN_LEN {
            return None;
        }
        let token_hash = hash_api_token(token);
        let row = sqlx::query(
            "SELECT id, account_uuid, token_hash
             FROM admin_api_tokens
             WHERE token_hash = $1
               AND revoked_at IS NULL
               AND (expires_at IS NULL OR expires_at > now())",
        )
        .bind(&token_hash)
        .fetch_optional(self.pool())
        .await
        .ok()
        .flatten()?;

        let stored_hash: String = row.get("token_hash");
        if !constant_time_eq(token_hash.as_bytes(), stored_hash.as_bytes()) {
            return None;
        }

        let token_id: i64 = row.get("id");
        // Ошибку обновления отметки глотаем: токен уже признан валидным,
        // а `last_used_at` — вспомогательная информация.
        // make_interval(days => ...) ждёт int4. Здесь интервал — константа
        // в SQL, чтобы не ловить несовпадение типов bind-параметра.
        let _ = sqlx::query(&format!(
            "UPDATE admin_api_tokens SET last_used_at = now()
             WHERE id = $1
               AND (last_used_at IS NULL
                    OR last_used_at < now() - make_interval(secs => {LAST_USED_THROTTLE_SECS}))"
        ))
        .bind(token_id)
        .execute(self.pool())
        .await;

        Some(ApiTokenOwner {
            token_id,
            account_uuid: row.get("account_uuid"),
        })
    }

    /// Пишет запись аудита программной операции. Вызывающий сам решает,
    /// валить ли запрос при ошибке (см. `api_v1`: пишем лог и продолжаем).
    pub async fn record_api_audit(&self, entry: &ApiAuditEntry) -> Result<(), StoreError> {
        sqlx::query(
            "INSERT INTO admin_api_audit
                (token_id, account_uuid, action, build_id, file_id, sha1, path, detail)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)",
        )
        .bind(entry.token_id)
        .bind(normalize_uuid(&entry.account_uuid))
        .bind(&entry.action)
        .bind(entry.build_id)
        .bind(entry.file_id)
        .bind(&entry.sha1)
        .bind(&entry.path)
        .bind(&entry.detail)
        .execute(self.pool())
        .await?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn generated_token_has_prefix_and_expected_length() {
        let token = generate_api_token();
        assert!(token.starts_with(API_TOKEN_PREFIX));
        // "sd_" + 32 байта в hex.
        assert_eq!(token.len(), API_TOKEN_PREFIX.len() + API_TOKEN_BYTES * 2);
        assert!(token[API_TOKEN_PREFIX.len()..]
            .chars()
            .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()));
        let other = generate_api_token();
        assert_ne!(token, other, "токены должны быть непредсказуемы");
    }

    #[test]
    fn token_hash_is_deterministic_and_matches_in_constant_time() {
        let token = generate_api_token();
        let hash = hash_api_token(&token);
        assert_eq!(hash.len(), 64);
        assert_eq!(hash, hash_api_token(&token));
        assert!(api_token_matches(&token, &hash));
        assert!(!api_token_matches(&generate_api_token(), &hash));
        assert!(!api_token_matches(&token[..token.len() - 1], &hash));
        assert!(!api_token_matches("", &hash));
    }

    #[test]
    fn token_prefix_never_reveals_secret() {
        let token = generate_api_token();
        let prefix = token_prefix(&token);
        assert_eq!(prefix, &token[..API_TOKEN_PREFIX.len() + 8]);
        assert!(prefix.len() < token.len());
    }
}
