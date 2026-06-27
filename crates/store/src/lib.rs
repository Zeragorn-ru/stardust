//! Общий слой хранилища платформы (PostgreSQL).
//!
//! Фасад `Store` скрывает за собой работу с БД. Им пользуются и
//! `auth-server` (аккаунты, сессии, скины), и `admin-server` (управление
//! аккаунтами и сборкой). Реализация — `sqlx` поверх `PgPool`.
//!
//! Записи `join` (Yggdrasil) остаются в памяти: они эфемерны (живут секунды)
//! и теряются при перезапуске без последствий.

use std::collections::HashMap;
use std::sync::RwLock;
use std::time::{Duration, Instant};

use protocol::{PlayerProfile, SkinModel};
use sha2::{Digest, Sha256};
use sqlx::postgres::{PgPoolOptions, PgRow};
use sqlx::{PgPool, Row};
use time::OffsetDateTime;

mod build;
mod telegram;
pub use build::{
    BuildFileInput, BuildFileMeta, BuildFileRow, BuildHeader, BuildRecord, NewBuild, UpdateBuild,
};
pub use telegram::{
    ChallengeAnswer, ChallengeOutcome, OutboxMessage, CALLBACK_APPROVE, CALLBACK_DENY,
    CHALLENGE_LOGIN_2FA, CHALLENGE_PASSWORDLESS, CHALLENGE_PASSWORD_RESET, SETTING_SFTP_HOST,
    SETTING_SFTP_PASSWORD, SETTING_SFTP_USERNAME, SETTING_TELEGRAM_TOKEN,
    SETTING_TELEGRAM_USERNAME,
};

/// Скин игрока, хранимый сервером.
#[derive(Debug, Clone)]
pub struct StoredSkin {
    /// Сырые байты PNG.
    pub png: Vec<u8>,
    /// Модель (classic/slim). Пойдёт в метаданные текстуры Yggdrasil.
    pub model: SkinModel,
    /// SHA-256 содержимого PNG (hex). Имя файла текстуры в Yggdrasil-URL.
    pub sha256: String,
    /// PNG плаща и его SHA-256, если плащ задан.
    pub cape: Option<StoredCape>,
    /// Источник синхронизации (UUID Mojang без дефисов), если скин импортирован.
    pub sync_source: Option<String>,
}

/// Плащ игрока, хранимый рядом со скином.
#[derive(Debug, Clone)]
pub struct StoredCape {
    pub png: Vec<u8>,
    pub sha256: String,
}

impl StoredSkin {
    /// Создаёт скин, попутно вычисляя SHA-256 для Yggdrasil-URL.
    pub fn new(
        png: Vec<u8>,
        model: SkinModel,
        cape_png: Option<Vec<u8>>,
        sync_source: Option<String>,
    ) -> Self {
        let sha256 = to_hex(&Sha256::digest(&png));
        let cape = cape_png.map(|png| StoredCape {
            sha256: to_hex(&Sha256::digest(&png)),
            png,
        });
        Self {
            png,
            model,
            sha256,
            cape,
            sync_source,
        }
    }
}

/// Запись о входе игрока на сервер (Yggdrasil `join` → `hasJoined`).
#[derive(Debug, Clone)]
struct JoinRecord {
    access_token: String,
    created: Instant,
}

/// Сколько живёт запись о `join` до проверки сервером.
const JOIN_TTL: Duration = Duration::from_secs(30);

/// Один аккаунт.
#[derive(Debug, Clone)]
pub struct Account {
    /// UUID без дефисов — сгенерирован сервером при регистрации.
    pub uuid: String,
    pub username: String,
    /// `salt:hash` в hex (SHA-256).
    password_hash: String,
    pub skin: Option<StoredSkin>,
    /// Привязка Telegram для 2FA.
    pub telegram_chat_id: Option<String>,
    /// Роль аккаунта. `admin` имеет доступ к веб-админке.
    pub role: Role,
    /// Состояние блокировки аккаунта.
    pub ban: Option<Ban>,
}

/// Активная блокировка аккаунта.
#[derive(Debug, Clone)]
pub struct Ban {
    /// Момент окончания временного бана. `None` — бан навсегда.
    pub until: Option<OffsetDateTime>,
    /// Причина блокировки (показывается игроку и админу).
    pub reason: Option<String>,
}

impl Ban {
    /// Истёк ли временный бан к моменту `now`.
    pub fn is_expired(&self, now: OffsetDateTime) -> bool {
        matches!(self.until, Some(until) if until <= now)
    }
}

/// Роль аккаунта.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Role {
    User,
    Admin,
}

impl Role {
    pub fn as_str(self) -> &'static str {
        match self {
            Role::User => "user",
            Role::Admin => "admin",
        }
    }

    pub fn from_str(s: &str) -> Self {
        match s {
            "admin" => Role::Admin,
            _ => Role::User,
        }
    }
}

impl Account {
    /// Профиль для отдачи лаунчеру.
    pub fn profile(&self) -> PlayerProfile {
        PlayerProfile {
            id: self.uuid.clone(),
            name: self.username.clone(),
        }
    }

    pub fn is_admin(&self) -> bool {
        self.role == Role::Admin
    }

    pub fn has_telegram(&self) -> bool {
        self.telegram_chat_id.is_some()
    }

    /// Действует ли блокировка прямо сейчас (с учётом истечения временного бана).
    pub fn is_banned(&self) -> bool {
        match &self.ban {
            Some(ban) => !ban.is_expired(OffsetDateTime::now_utc()),
            None => false,
        }
    }
}

/// Ошибки работы с хранилищем.
#[derive(Debug, thiserror::Error)]
pub enum StoreError {
    #[error("имя уже занято")]
    NameTaken,
    #[error("не найдено")]
    NotFound,
    #[error("неверный пароль")]
    BadPassword,
    #[error("слишком часто, попробуйте позже")]
    TooMany,
    #[error("сбой хранилища: {0}")]
    Backend(String),
}

impl From<sqlx::Error> for StoreError {
    fn from(e: sqlx::Error) -> Self {
        StoreError::Backend(e.to_string())
    }
}

/// Колонки аккаунта, которые мы всегда выбираем.
const ACCOUNT_COLUMNS: &str = "uuid, username, password_hash, telegram_chat_id, role, \
     skin_png, skin_model, skin_sha256, cape_png, cape_sha256, sync_source, \
     banned, banned_until, ban_reason";

/// Фасад хранилища.
pub struct Store {
    pool: PgPool,
    /// Записи `join`: serverId -> запись. Кратковременные (см. `JOIN_TTL`).
    joins: RwLock<HashMap<String, JoinRecord>>,
}

impl Store {
    /// Подключается к Postgres по `database_url` и применяет миграции.
    pub async fn connect(database_url: &str) -> Result<Self, StoreError> {
        let pool = PgPoolOptions::new()
            .max_connections(10)
            .connect(database_url)
            .await?;
        Self::from_pool(pool).await
    }

    /// Создаёт хранилище поверх готового пула (миграции применяются здесь).
    pub async fn from_pool(pool: PgPool) -> Result<Self, StoreError> {
        sqlx::migrate!("./migrations")
            .run(&pool)
            .await
            .map_err(|e| StoreError::Backend(format!("миграции: {e}")))?;
        Ok(Self {
            pool,
            joins: RwLock::new(HashMap::new()),
        })
    }

    /// Доступ к пулу — нужен admin-серверу для запросов сборки.
    pub fn pool(&self) -> &PgPool {
        &self.pool
    }

    // ───────────────────────── Аккаунты ─────────────────────────

    /// Регистрирует аккаунт. UUID генерируется строго случайно сервером.
    pub async fn register(
        &self,
        username: &str,
        password: &str,
    ) -> Result<PlayerProfile, StoreError> {
        let key = username.to_lowercase();
        let exists: Option<i32> =
            sqlx::query_scalar("SELECT 1 FROM accounts WHERE username_lower = $1")
                .bind(&key)
                .fetch_optional(&self.pool)
                .await?;
        if exists.is_some() {
            return Err(StoreError::NameTaken);
        }
        let uuid = random_uuid_no_dashes();
        sqlx::query(
            "INSERT INTO accounts (uuid, username, username_lower, password_hash, role)
             VALUES ($1, $2, $3, $4, 'user')",
        )
        .bind(&uuid)
        .bind(username)
        .bind(&key)
        .bind(hash_password(password))
        .execute(&self.pool)
        .await?;
        Ok(PlayerProfile {
            id: uuid,
            name: username.to_string(),
        })
    }

    /// Проверяет логин/пароль, возвращает профиль.
    pub async fn login(&self, username: &str, password: &str) -> Result<PlayerProfile, StoreError> {
        let account = self
            .find_by_name(username)
            .await
            .ok_or(StoreError::NotFound)?;
        if verify_password(password, &account.password_hash) {
            Ok(account.profile())
        } else {
            Err(StoreError::BadPassword)
        }
    }

    /// Меняет пароль аккаунта после проверки текущего.
    pub async fn change_password(
        &self,
        uuid: &str,
        current: &str,
        new_password: &str,
    ) -> Result<(), StoreError> {
        let account = self.find_by_uuid(uuid).await.ok_or(StoreError::NotFound)?;
        if !verify_password(current, &account.password_hash) {
            return Err(StoreError::BadPassword);
        }
        sqlx::query("UPDATE accounts SET password_hash = $1 WHERE uuid = $2")
            .bind(hash_password(new_password))
            .bind(&account.uuid)
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    /// Устанавливает новый пароль без проверки текущего. Вызывается только
    /// после подтверждения личности через Telegram (сценарий сброса пароля).
    pub async fn reset_password(&self, uuid: &str, new_password: &str) -> Result<(), StoreError> {
        let uuid = normalize_uuid(uuid);
        let changed = sqlx::query("UPDATE accounts SET password_hash = $1 WHERE uuid = $2")
            .bind(hash_password(new_password))
            .bind(&uuid)
            .execute(&self.pool)
            .await?
            .rows_affected();
        if changed == 0 {
            return Err(StoreError::NotFound);
        }
        Ok(())
    }

    /// Переименовывает аккаунт (с проверкой занятости нового ника).
    pub async fn rename(
        &self,
        uuid: &str,
        new_username: &str,
    ) -> Result<PlayerProfile, StoreError> {
        let uuid = normalize_uuid(uuid);
        let new_key = new_username.to_lowercase();
        let taken: Option<i32> =
            sqlx::query_scalar("SELECT 1 FROM accounts WHERE username_lower = $1 AND uuid <> $2")
                .bind(&new_key)
                .bind(&uuid)
                .fetch_optional(&self.pool)
                .await?;
        if taken.is_some() {
            return Err(StoreError::NameTaken);
        }
        let changed =
            sqlx::query("UPDATE accounts SET username = $1, username_lower = $2 WHERE uuid = $3")
                .bind(new_username)
                .bind(&new_key)
                .bind(&uuid)
                .execute(&self.pool)
                .await?
                .rows_affected();
        if changed == 0 {
            return Err(StoreError::NotFound);
        }
        Ok(PlayerProfile {
            id: uuid,
            name: new_username.to_string(),
        })
    }

    /// Привязывает/отвязывает Telegram chat_id (точка интеграции с ботом 2FA).
    pub async fn set_telegram(&self, uuid: &str, chat_id: Option<&str>) -> Result<(), StoreError> {
        let uuid = normalize_uuid(uuid);
        let changed = sqlx::query("UPDATE accounts SET telegram_chat_id = $1 WHERE uuid = $2")
            .bind(chat_id)
            .bind(&uuid)
            .execute(&self.pool)
            .await?
            .rows_affected();
        if changed == 0 {
            return Err(StoreError::NotFound);
        }
        Ok(())
    }

    /// Меняет роль аккаунта (для admin-сервера).
    pub async fn set_role(&self, uuid: &str, role: Role) -> Result<(), StoreError> {
        let uuid = normalize_uuid(uuid);
        let changed = sqlx::query("UPDATE accounts SET role = $1 WHERE uuid = $2")
            .bind(role.as_str())
            .bind(&uuid)
            .execute(&self.pool)
            .await?
            .rows_affected();
        if changed == 0 {
            return Err(StoreError::NotFound);
        }
        Ok(())
    }

    /// Удаляет аккаунт (для admin-сервера). Каскадно удаляет его сессии.
    pub async fn delete_account(&self, uuid: &str) -> Result<(), StoreError> {
        let uuid = normalize_uuid(uuid);
        let changed = sqlx::query("DELETE FROM accounts WHERE uuid = $1")
            .bind(&uuid)
            .execute(&self.pool)
            .await?
            .rows_affected();
        if changed == 0 {
            return Err(StoreError::NotFound);
        }
        Ok(())
    }

    /// Удаляет аккаунт владельцем после проверки пароля (само-удаление
    /// из лаунчера). Каскадно удаляет сессии аккаунта.
    pub async fn delete_account_with_password(
        &self,
        uuid: &str,
        password: &str,
    ) -> Result<(), StoreError> {
        let account = self.find_by_uuid(uuid).await.ok_or(StoreError::NotFound)?;
        if !verify_password(password, &account.password_hash) {
            return Err(StoreError::BadPassword);
        }
        self.delete_account(&account.uuid).await
    }

    /// Блокирует аккаунт. `until = None` — бан навсегда; иначе временный бан
    /// до указанного момента. Сессии аккаунта удаляются, чтобы выкинуть его.
    pub async fn ban_account(
        &self,
        uuid: &str,
        until: Option<OffsetDateTime>,
        reason: Option<&str>,
    ) -> Result<(), StoreError> {
        let uuid = normalize_uuid(uuid);
        let changed = sqlx::query(
            "UPDATE accounts SET banned = TRUE, banned_until = $1, ban_reason = $2 WHERE uuid = $3",
        )
        .bind(until)
        .bind(reason)
        .bind(&uuid)
        .execute(&self.pool)
        .await?
        .rows_affected();
        if changed == 0 {
            return Err(StoreError::NotFound);
        }
        // Активные сессии забаненного больше не должны работать.
        sqlx::query("DELETE FROM sessions WHERE account_uuid = $1")
            .bind(&uuid)
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    /// Снимает блокировку с аккаунта.
    pub async fn unban_account(&self, uuid: &str) -> Result<(), StoreError> {
        let uuid = normalize_uuid(uuid);
        let changed = sqlx::query(
            "UPDATE accounts SET banned = FALSE, banned_until = NULL, ban_reason = NULL \
             WHERE uuid = $1",
        )
        .bind(&uuid)
        .execute(&self.pool)
        .await?
        .rows_affected();
        if changed == 0 {
            return Err(StoreError::NotFound);
        }
        Ok(())
    }

    /// Находит аккаунт по UUID (без дефисов).
    pub async fn find_by_uuid(&self, uuid: &str) -> Option<Account> {
        let uuid = normalize_uuid(uuid);
        let sql = format!("SELECT {ACCOUNT_COLUMNS} FROM accounts WHERE uuid = $1");
        sqlx::query(&sql)
            .bind(&uuid)
            .fetch_optional(&self.pool)
            .await
            .ok()
            .flatten()
            .map(|row| row_to_account(&row))
    }

    /// Находит аккаунт по нику.
    pub async fn find_by_name(&self, username: &str) -> Option<Account> {
        let key = username.to_lowercase();
        let sql = format!("SELECT {ACCOUNT_COLUMNS} FROM accounts WHERE username_lower = $1");
        sqlx::query(&sql)
            .bind(&key)
            .fetch_optional(&self.pool)
            .await
            .ok()
            .flatten()
            .map(|row| row_to_account(&row))
    }

    /// Находит аккаунты по никам (пакетный запрос, один SELECT).
    pub async fn find_by_names(&self, names: &[String]) -> Vec<Account> {
        if names.is_empty() {
            return Vec::new();
        }
        let keys: Vec<String> = names.iter().map(|n| n.to_lowercase()).collect();
        let sql = format!(
            "SELECT {ACCOUNT_COLUMNS} FROM accounts WHERE username_lower = ANY($1)"
        );
        sqlx::query(&sql)
            .bind(&keys)
            .fetch_all(&self.pool)
            .await
            .map(|rows| rows.iter().map(row_to_account).collect())
            .unwrap_or_default()
    }

    /// Список всех аккаунтов (для веб-админки).
    pub async fn all_accounts(&self) -> Result<Vec<Account>, StoreError> {
        let sql = format!("SELECT {ACCOUNT_COLUMNS} FROM accounts ORDER BY username_lower");
        let rows = sqlx::query(&sql).fetch_all(&self.pool).await?;
        Ok(rows.iter().map(row_to_account).collect())
    }

    /// Сохраняет/заменяет скин аккаунта (по UUID без дефисов).
    pub async fn set_skin(&self, uuid: &str, skin: StoredSkin) -> Result<(), StoreError> {
        let uuid = normalize_uuid(uuid);
        let (cape_png, cape_sha) = match &skin.cape {
            Some(c) => (Some(c.png.clone()), Some(c.sha256.clone())),
            None => (None, None),
        };
        let changed = sqlx::query(
            "UPDATE accounts SET skin_png = $1, skin_model = $2, skin_sha256 = $3,
                    cape_png = $4, cape_sha256 = $5, sync_source = $6 WHERE uuid = $7",
        )
        .bind(skin.png)
        .bind(model_to_str(skin.model))
        .bind(skin.sha256)
        .bind(cape_png)
        .bind(cape_sha)
        .bind(skin.sync_source)
        .bind(&uuid)
        .execute(&self.pool)
        .await?
        .rows_affected();
        if changed == 0 {
            return Err(StoreError::NotFound);
        }
        Ok(())
    }

    /// Находит текстуру (скин или плащ) по SHA-256 для отдачи `/textures/<hash>`.
    pub async fn find_texture_by_hash(&self, hash: &str) -> Option<Vec<u8>> {
        let hash = hash.to_lowercase();
        let skin: Option<Vec<u8>> =
            sqlx::query_scalar("SELECT skin_png FROM accounts WHERE skin_sha256 = $1")
                .bind(&hash)
                .fetch_optional(&self.pool)
                .await
                .ok()
                .flatten();
        if skin.is_some() {
            return skin;
        }
        sqlx::query_scalar("SELECT cape_png FROM accounts WHERE cape_sha256 = $1")
            .bind(&hash)
            .fetch_optional(&self.pool)
            .await
            .ok()
            .flatten()
    }

    /// Возвращает список (uuid, source) аккаунтов с включённой синхронизацией скина.
    pub async fn synced_skins(&self) -> Vec<(String, String)> {
        sqlx::query("SELECT uuid, sync_source FROM accounts WHERE sync_source IS NOT NULL")
            .fetch_all(&self.pool)
            .await
            .map(|rows| {
                rows.iter()
                    .map(|r| {
                        (
                            r.get::<String, _>("uuid"),
                            r.get::<String, _>("sync_source"),
                        )
                    })
                    .collect()
            })
            .unwrap_or_default()
    }

    // ───────────────────────── Сессии ─────────────────────────

    /// Создаёт сессию для аккаунта и возвращает bearer-токен.
    pub async fn create_session(&self, uuid: &str) -> Result<String, StoreError> {
        let token = random_token();
        sqlx::query("INSERT INTO sessions (token, account_uuid) VALUES ($1, $2)")
            .bind(&token)
            .bind(normalize_uuid(uuid))
            .execute(&self.pool)
            .await?;
        Ok(token)
    }

    /// Проверяет bearer-токен и возвращает UUID аккаунта, если сессия жива.
    pub async fn validate_session(&self, token: &str) -> Option<String> {
        sqlx::query_scalar("SELECT account_uuid FROM sessions WHERE token = $1")
            .bind(token)
            .fetch_optional(&self.pool)
            .await
            .ok()
            .flatten()
    }

    /// Удаляет сессию (logout).
    pub async fn destroy_session(&self, token: &str) -> Result<(), StoreError> {
        sqlx::query("DELETE FROM sessions WHERE token = $1")
            .bind(token)
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    /// Удаляет все сессии аккаунта (например, после смены пароля).
    pub async fn destroy_sessions_for(&self, uuid: &str) -> Result<(), StoreError> {
        sqlx::query("DELETE FROM sessions WHERE account_uuid = $1")
            .bind(normalize_uuid(uuid))
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    // ─────────────────────── join (в памяти) ───────────────────────

    /// Запоминает `join` от клиента: serverId -> accessToken.
    pub fn record_join(&self, server_id: &str, access_token: &str) {
        let mut joins = self.joins.write().unwrap();
        joins.retain(|_, r| r.created.elapsed() < JOIN_TTL);
        joins.insert(
            server_id.to_string(),
            JoinRecord {
                access_token: access_token.to_string(),
                created: Instant::now(),
            },
        );
    }

    /// Возвращает accessToken по `serverId`, если запись свежая.
    pub fn join_access_token(&self, server_id: &str) -> Option<String> {
        let joins = self.joins.read().unwrap();
        joins
            .get(server_id)
            .filter(|r| r.created.elapsed() < JOIN_TTL)
            .map(|r| r.access_token.clone())
    }
}

fn row_to_account(row: &PgRow) -> Account {
    let skin_png: Option<Vec<u8>> = row.get("skin_png");
    let skin = skin_png.map(|png| {
        let model = row
            .get::<Option<String>, _>("skin_model")
            .as_deref()
            .map(str_to_model)
            .unwrap_or_default();
        let sha256 = row
            .get::<Option<String>, _>("skin_sha256")
            .unwrap_or_default();
        let cape = row
            .get::<Option<Vec<u8>>, _>("cape_png")
            .map(|cape_png| StoredCape {
                sha256: row
                    .get::<Option<String>, _>("cape_sha256")
                    .unwrap_or_default(),
                png: cape_png,
            });
        StoredSkin {
            png,
            model,
            sha256,
            cape,
            sync_source: row.get("sync_source"),
        }
    });
    Account {
        uuid: row.get("uuid"),
        username: row.get("username"),
        password_hash: row.get("password_hash"),
        telegram_chat_id: row.get("telegram_chat_id"),
        role: Role::from_str(&row.get::<String, _>("role")),
        skin,
        ban: if row.get::<bool, _>("banned") {
            Some(Ban {
                until: row.get("banned_until"),
                reason: row.get("ban_reason"),
            })
        } else {
            None
        },
    }
}

fn model_to_str(model: SkinModel) -> &'static str {
    match model {
        SkinModel::Classic => "classic",
        SkinModel::Slim => "slim",
    }
}

fn str_to_model(s: &str) -> SkinModel {
    match s {
        "slim" => SkinModel::Slim,
        _ => SkinModel::Classic,
    }
}

fn normalize_uuid(uuid: &str) -> String {
    uuid.replace('-', "").to_lowercase()
}

/// UUID v4 без дефисов в нижнем регистре (формат Mojang).
fn random_uuid_no_dashes() -> String {
    uuid::Uuid::new_v4().simple().to_string()
}

/// Непредсказуемый bearer-токен для API-сессии.
fn random_token() -> String {
    use rand::RngCore;
    let mut bytes = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut bytes);
    to_hex(&bytes)
}

/// SHA-256 пароля со случайной солью; формат `salt_hex:hash_hex`.
fn hash_password(password: &str) -> String {
    use rand::RngCore;
    let mut salt = [0u8; 16];
    rand::thread_rng().fill_bytes(&mut salt);
    let salt_hex = to_hex(&salt);
    let hash = digest_with_salt(password, &salt_hex);
    format!("{salt_hex}:{hash}")
}

fn verify_password(password: &str, stored: &str) -> bool {
    let Some((salt_hex, expected)) = stored.split_once(':') else {
        return false;
    };
    let actual = digest_with_salt(password, salt_hex);
    constant_time_eq(actual.as_bytes(), expected.as_bytes())
}

fn digest_with_salt(password: &str, salt_hex: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(salt_hex.as_bytes());
    hasher.update(password.as_bytes());
    to_hex(&hasher.finalize())
}

fn to_hex(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut s = String::with_capacity(bytes.len() * 2);
    for &b in bytes {
        s.push(HEX[(b >> 4) as usize] as char);
        s.push(HEX[(b & 0x0f) as usize] as char);
    }
    s
}

fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (x, y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}
