//! Интеграция с Telegram: настройки, привязка аккаунтов, 2FA и outbox.
//!
//! Серверы (auth/admin) не общаются с Telegram напрямую — они только пишут в
//! `telegram_outbox`, а сервис `telegram-bot` забирает оттуда сообщения и
//! отправляет их. Токен бота лежит в таблице `settings`, чтобы менять его из
//! админки без рестарта контейнеров.

use rand::Rng;
use sqlx::Row;
use time::{Duration, OffsetDateTime};

use crate::{normalize_uuid, Store, StoreError};

/// Ключ настройки: токен Telegram-бота (BotFather).
pub const SETTING_TELEGRAM_TOKEN: &str = "telegram_bot_token";
/// Ключ настройки: закэшированный username бота (`@name`), для UI и deep-link.
pub const SETTING_TELEGRAM_USERNAME: &str = "telegram_bot_username";

/// Ключ настройки: SFTP-хост сервера (`host` или `host:port`).
pub const SETTING_SFTP_HOST: &str = "sftp_host";
/// Ключ настройки: SFTP-логин.
pub const SETTING_SFTP_USERNAME: &str = "sftp_username";
/// Ключ настройки: SFTP-пароль (секрет, наружу не отдаём).
pub const SETTING_SFTP_PASSWORD: &str = "sftp_password";
/// Ключ настройки: путь к папке stats на Minecraft-сервере (например `/world/stats`).
pub const SETTING_SFTP_STATS_PATH: &str = "sftp_stats_path";

/// Время жизни кода привязки Telegram.
const LINK_TTL: Duration = Duration::minutes(15);
/// Время жизни кода 2FA.
const CODE_2FA_TTL: Duration = Duration::minutes(5);
/// Максимум попыток ввода кода 2FA на один challenge.
const MAX_2FA_ATTEMPTS: i32 = 5;
/// Минимальный интервал между запросами подтверждения для одного аккаунта —
/// защита от спама пушами в Telegram (особенно при входе по одному нику).
const CHALLENGE_COOLDOWN: Duration = Duration::seconds(30);

/// Назначение challenge: один механизм обслуживает несколько сценариев.
pub const CHALLENGE_LOGIN_2FA: &str = "login_2fa";
/// Вход только по нику, без пароля (подтверждается кнопкой в Telegram).
pub const CHALLENGE_PASSWORDLESS: &str = "passwordless";
/// Сброс забытого пароля после подтверждения личности в Telegram.
pub const CHALLENGE_PASSWORD_RESET: &str = "password_reset";

/// Префиксы `callback_data` кнопок подтверждения (бот шлёт их обратно).
pub const CALLBACK_APPROVE: &str = "ok";
pub const CALLBACK_DENY: &str = "no";

/// Одно сообщение из очереди на отправку (для сервиса telegram-bot).
#[derive(Debug, Clone)]
pub struct OutboxMessage {
    pub id: i64,
    pub chat_id: String,
    pub text: String,
    /// Inline-клавиатура (JSON `reply_markup`), если у сообщения есть кнопки.
    pub reply_markup: Option<String>,
    /// Режим разметки Telegram (`HTML`), если текст содержит разметку.
    /// `None` — обычный текст.
    pub parse_mode: Option<String>,
    pub document_name: Option<String>,
    pub document_content: Option<Vec<u8>>,
}

/// Итог опроса challenge лаунчером (polling статуса подтверждения).
#[derive(Debug, Clone)]
pub enum ChallengeOutcome {
    /// Пользователь ещё не ответил.
    Pending,
    /// Подтверждено кнопкой «Это я». Несёт UUID аккаунта; запись удалена.
    Approved(String),
    /// Отклонено кнопкой «Это не я». Запись удалена.
    Denied,
    /// Истёк срок или превышен лимит попыток. Запись удалена.
    Expired,
    /// Challenge с таким идентификатором не найден.
    NotFound,
}

/// Результат обработки нажатия кнопки (для ответа бота пользователю).
#[derive(Debug, Clone)]
pub enum ChallengeAnswer {
    /// Действие учтено: `approve` — подтверждено, иначе отклонено.
    Done { approve: bool, username: String },
    /// Истёк/не найден — кнопка устарела.
    Stale,
    /// Этот чат не связан с аккаунтом challenge.
    Forbidden,
}

impl Store {
    // ───────────────────────── Настройки ─────────────────────────

    /// Возвращает значение настройки по ключу.
    pub async fn get_setting(&self, key: &str) -> Result<Option<String>, StoreError> {
        let value: Option<String> = sqlx::query_scalar("SELECT value FROM settings WHERE key = $1")
            .bind(key)
            .fetch_optional(&self.pool)
            .await?;
        Ok(value)
    }

    /// Возвращает несколько настроек за один запрос (key -> value).
    pub async fn get_settings_batch(
        &self,
        keys: &[&str],
    ) -> Result<std::collections::HashMap<String, Option<String>>, StoreError> {
        let rows: Vec<(String, Option<String>)> =
            sqlx::query_as("SELECT key, value FROM settings WHERE key = ANY($1)")
                .bind(keys)
                .fetch_all(&self.pool)
                .await?;
        let mut map = std::collections::HashMap::new();
        for key in keys {
            map.insert(key.to_string(), None);
        }
        for (k, v) in rows {
            map.insert(k, v);
        }
        Ok(map)
    }

    /// Устанавливает (upsert) значение настройки.
    pub async fn set_setting(&self, key: &str, value: &str) -> Result<(), StoreError> {
        sqlx::query(
            "INSERT INTO settings (key, value, updated_at) VALUES ($1, $2, now())
             ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()",
        )
        .bind(key)
        .bind(value)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    /// Удаляет настройку (например, чтобы отключить бота, убрав токен).
    pub async fn delete_setting(&self, key: &str) -> Result<(), StoreError> {
        sqlx::query("DELETE FROM settings WHERE key = $1")
            .bind(key)
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    // ───────────────────── Сброс пароля админом ─────────────────────

    /// Устанавливает новый пароль аккаунта без проверки старого (сброс
    /// админом). Сбрасывает активные сессии, чтобы старые токены протухли.
    pub async fn set_password(&self, uuid: &str, new_password: &str) -> Result<(), StoreError> {
        let uuid = normalize_uuid(uuid);
        let changed = sqlx::query("UPDATE accounts SET password_hash = $1 WHERE uuid = $2")
            .bind(crate::hash_password(new_password))
            .bind(&uuid)
            .execute(&self.pool)
            .await?
            .rows_affected();
        if changed == 0 {
            return Err(StoreError::NotFound);
        }
        sqlx::query("DELETE FROM sessions WHERE account_uuid = $1")
            .bind(&uuid)
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    // ───────────────────── Привязка Telegram ─────────────────────

    /// Создаёт одноразовый код привязки для аккаунта. Прежние коды этого
    /// аккаунта удаляются. Возвращает код для `/start <code>`.
    pub async fn create_link_token(&self, uuid: &str) -> Result<String, StoreError> {
        let uuid = normalize_uuid(uuid);
        sqlx::query("DELETE FROM telegram_link_tokens WHERE account_uuid = $1")
            .bind(&uuid)
            .execute(&self.pool)
            .await?;
        let code = random_code(8);
        let expires = OffsetDateTime::now_utc() + LINK_TTL;
        sqlx::query(
            "INSERT INTO telegram_link_tokens (code, account_uuid, expires_at)
             VALUES ($1, $2, $3)",
        )
        .bind(&code)
        .bind(&uuid)
        .bind(expires)
        .execute(&self.pool)
        .await?;
        Ok(code)
    }

    /// Привязывает chat_id к аккаунту по коду из `/start <code>`. Возвращает
    /// username привязанного аккаунта при успехе. Используется telegram-ботом.
    pub async fn link_telegram_by_code(
        &self,
        code: &str,
        chat_id: &str,
    ) -> Result<String, StoreError> {
        let now = OffsetDateTime::now_utc();
        let row = sqlx::query(
            "SELECT account_uuid, expires_at FROM telegram_link_tokens WHERE code = $1",
        )
        .bind(code)
        .fetch_optional(&self.pool)
        .await?
        .ok_or(StoreError::NotFound)?;

        let account_uuid: String = row.get("account_uuid");
        let expires_at: OffsetDateTime = row.get("expires_at");
        if expires_at <= now {
            sqlx::query("DELETE FROM telegram_link_tokens WHERE code = $1")
                .bind(code)
                .execute(&self.pool)
                .await?;
            return Err(StoreError::NotFound);
        }

        sqlx::query("UPDATE accounts SET telegram_chat_id = $1 WHERE uuid = $2")
            .bind(chat_id)
            .bind(&account_uuid)
            .execute(&self.pool)
            .await?;
        sqlx::query("DELETE FROM telegram_link_tokens WHERE code = $1")
            .bind(code)
            .execute(&self.pool)
            .await?;

        let username: String = sqlx::query_scalar("SELECT username FROM accounts WHERE uuid = $1")
            .bind(&account_uuid)
            .fetch_one(&self.pool)
            .await?;
        Ok(username)
    }

    /// Отвязывает Telegram от аккаунта по chat_id (команда `/unlink` в боте).
    /// Возвращает true, если что-то было отвязано.
    pub async fn unlink_telegram_by_chat(&self, chat_id: &str) -> Result<bool, StoreError> {
        let changed =
            sqlx::query("UPDATE accounts SET telegram_chat_id = NULL WHERE telegram_chat_id = $1")
                .bind(chat_id)
                .execute(&self.pool)
                .await?
                .rows_affected();
        Ok(changed > 0)
    }

    // ───────────────────────── Challenge (2FA / passwordless / reset) ─────────────────────────

    /// Запускает challenge заданного назначения: создаёт код, кладёт в outbox
    /// сообщение с кнопками «Это я»/«Это не я» (и кодом-фолбэком) и возвращает
    /// `challenge`. Если у аккаунта нет привязанного Telegram — `Ok(None)`.
    ///
    /// Для защиты от спама пушами действует cooldown: если по аккаунту уже есть
    /// свежая попытка моложе `CHALLENGE_COOLDOWN`, возвращается `TooMany`.
    pub async fn start_challenge(
        &self,
        uuid: &str,
        purpose: &str,
        client_ip: Option<&str>,
    ) -> Result<Option<String>, StoreError> {
        let uuid = normalize_uuid(uuid);
        let row: Option<(Option<String>, String)> =
            sqlx::query_as("SELECT telegram_chat_id, username FROM accounts WHERE uuid = $1")
                .bind(&uuid)
                .fetch_optional(&self.pool)
                .await?;
        let Some((Some(chat_id), username)) = row else {
            return Ok(None);
        };

        let now = OffsetDateTime::now_utc();
        // Анти-спам: не чаще одного запроса в CHALLENGE_COOLDOWN на аккаунт.
        // Учитываем только ещё активные (pending) и непросроченные попытки — уже
        // отвеченные («это я»/«это не я») или истёкшие challenge не должны
        // блокировать новый вход.
        let recent: Option<OffsetDateTime> = sqlx::query_scalar(
            "SELECT created_at FROM telegram_2fa_codes
             WHERE account_uuid = $1 AND status = 'pending' AND expires_at > $2
             ORDER BY created_at DESC LIMIT 1",
        )
        .bind(&uuid)
        .bind(now)
        .fetch_optional(&self.pool)
        .await?;
        if let Some(created) = recent {
            if now - created < CHALLENGE_COOLDOWN {
                return Err(StoreError::TooMany);
            }
        }

        // Старые незавершённые попытки этого аккаунта отбрасываем.
        sqlx::query("DELETE FROM telegram_2fa_codes WHERE account_uuid = $1")
            .bind(&uuid)
            .execute(&self.pool)
            .await?;

        let challenge = random_code(24);
        let code = random_numeric_code(6);
        let expires = now + CODE_2FA_TTL;
        sqlx::query(
            "INSERT INTO telegram_2fa_codes (challenge, account_uuid, code, expires_at, purpose, status, client_ip)
             VALUES ($1, $2, $3, $4, $5, 'pending', $6)",
        )
        .bind(&challenge)
        .bind(&uuid)
        .bind(&code)
        .bind(expires)
        .bind(purpose)
        .bind(client_ip)
        .execute(&self.pool)
        .await?;

        let (text, markup) = if purpose == CHALLENGE_PASSWORD_RESET {
            let t = format!(
                "Запрос сброса пароля в аккаунт <code>{nick}</code>.\nКод подтверждения: <code>{code}</code>\nДействует 5 минут. Если вы не запрашивали сброс пароля, проигнорируйте это сообщение.",
                nick = html_escape(&username)
            );
            (t, None)
        } else {
            let t = format!(
                "Запрос входа в аккаунт <code>{nick}</code>.\nЕсли это вы — нажмите «✅ Это я».\nКод (если нужно ввести вручную): <code>{code}</code>\nДействует 5 минут. Если это не вы — нажмите «🚫 Это не я».",
                nick = html_escape(&username)
            );
            (t, Some(approval_markup(&challenge)))
        };
        self.enqueue_message_full(&chat_id, &text, markup.as_deref(), Some("HTML"))
            .await?;
        Ok(Some(challenge))
    }

    /// Совместимость: запуск 2FA при входе по паролю.
    pub async fn start_2fa(&self, uuid: &str, client_ip: Option<&str>) -> Result<Option<String>, StoreError> {
        self.start_challenge(uuid, CHALLENGE_LOGIN_2FA, client_ip).await
    }

    /// Проверяет код challenge по `challenge` для входа (выдача сессии). При
    /// успехе возвращает UUID аккаунта и удаляет запись. Принимает только
    /// «входные» назначения (`login_2fa`, `passwordless`) — кодом сброса пароля
    /// нельзя получить сессию в обход смены пароля. Неверный код увеличивает
    /// счётчик попыток; по исчерпании лимита challenge уничтожается.
    pub async fn verify_2fa(&self, challenge: &str, code: &str) -> Result<String, StoreError> {
        self.verify_challenge(
            challenge,
            code,
            &[CHALLENGE_LOGIN_2FA, CHALLENGE_PASSWORDLESS],
        )
        .await
    }

    /// Как `verify_2fa`, но проверяет, что назначение challenge входит в
    /// `allowed_purposes`. Пустой срез означает «любое назначение».
    pub async fn verify_challenge(
        &self,
        challenge: &str,
        code: &str,
        allowed_purposes: &[&str],
    ) -> Result<String, StoreError> {
        let now = OffsetDateTime::now_utc();
        let row = sqlx::query(
            "SELECT account_uuid, code, expires_at, attempts, status, purpose
             FROM telegram_2fa_codes WHERE challenge = $1",
        )
        .bind(challenge)
        .fetch_optional(&self.pool)
        .await?
        .ok_or(StoreError::NotFound)?;

        let account_uuid: String = row.get("account_uuid");
        let expected: String = row.get("code");
        let expires_at: OffsetDateTime = row.get("expires_at");
        let attempts: i32 = row.get("attempts");
        let status: String = row.get("status");
        let purpose: String = row.get("purpose");

        let purpose_ok =
            allowed_purposes.is_empty() || allowed_purposes.iter().any(|p| *p == purpose);
        if expires_at <= now || attempts >= MAX_2FA_ATTEMPTS || status == "denied" || !purpose_ok {
            sqlx::query("DELETE FROM telegram_2fa_codes WHERE challenge = $1")
                .bind(challenge)
                .execute(&self.pool)
                .await?;
            return Err(StoreError::NotFound);
        }

        if !crate::constant_time_eq(code.trim().as_bytes(), expected.as_bytes()) {
            sqlx::query(
                "UPDATE telegram_2fa_codes SET attempts = attempts + 1 WHERE challenge = $1",
            )
            .bind(challenge)
            .execute(&self.pool)
            .await?;
            return Err(StoreError::BadPassword);
        }

        sqlx::query("DELETE FROM telegram_2fa_codes WHERE challenge = $1")
            .bind(challenge)
            .execute(&self.pool)
            .await?;
        Ok(account_uuid)
    }

    /// Опрос статуса challenge лаунчером (после нажатия кнопки в Telegram).
    /// При `approved`/`denied`/`expired` запись удаляется (одноразовость).
    /// При `expected_purpose = Some(p)` чужое назначение трактуется как NotFound.
    pub async fn poll_challenge(
        &self,
        challenge: &str,
        expected_purpose: Option<&str>,
    ) -> Result<ChallengeOutcome, StoreError> {
        let now = OffsetDateTime::now_utc();
        let row = sqlx::query(
            "SELECT account_uuid, expires_at, attempts, status, purpose
             FROM telegram_2fa_codes WHERE challenge = $1",
        )
        .bind(challenge)
        .fetch_optional(&self.pool)
        .await?;
        let Some(row) = row else {
            return Ok(ChallengeOutcome::NotFound);
        };

        let account_uuid: String = row.get("account_uuid");
        let expires_at: OffsetDateTime = row.get("expires_at");
        let attempts: i32 = row.get("attempts");
        let status: String = row.get("status");
        let purpose: String = row.get("purpose");

        if expected_purpose.map(|p| p != purpose).unwrap_or(false) {
            return Ok(ChallengeOutcome::NotFound);
        }

        // Завершающие состояния — удаляем запись после прочтения.
        let outcome = if status == "approved" {
            Some(ChallengeOutcome::Approved(account_uuid.clone()))
        } else if status == "denied" {
            Some(ChallengeOutcome::Denied)
        } else if expires_at <= now || attempts >= MAX_2FA_ATTEMPTS {
            Some(ChallengeOutcome::Expired)
        } else {
            None
        };

        if let Some(outcome) = outcome {
            sqlx::query("DELETE FROM telegram_2fa_codes WHERE challenge = $1")
                .bind(challenge)
                .execute(&self.pool)
                .await?;
            return Ok(outcome);
        }
        Ok(ChallengeOutcome::Pending)
    }

    /// Обрабатывает нажатие кнопки в Telegram: помечает challenge как
    /// `approved`/`denied`. Проверяет, что чат принадлежит владельцу challenge
    /// (нельзя подтвердить чужой вход из другого чата). Возвращает данные для
    /// ответа боту. Сама запись не удаляется — её заберёт `poll_challenge`.
    pub async fn answer_challenge(
        &self,
        challenge: &str,
        chat_id: &str,
        approve: bool,
    ) -> Result<ChallengeAnswer, StoreError> {
        let now = OffsetDateTime::now_utc();
        let row = sqlx::query(
            "SELECT t.account_uuid, t.expires_at, t.status, a.username, a.telegram_chat_id
             FROM telegram_2fa_codes t
             JOIN accounts a ON a.uuid = t.account_uuid
             WHERE t.challenge = $1",
        )
        .bind(challenge)
        .fetch_optional(&self.pool)
        .await?;
        let Some(row) = row else {
            return Ok(ChallengeAnswer::Stale);
        };

        let expires_at: OffsetDateTime = row.get("expires_at");
        let status: String = row.get("status");
        let username: String = row.get("username");
        let owner_chat: Option<String> = row.get("telegram_chat_id");

        if owner_chat.as_deref() != Some(chat_id) {
            return Ok(ChallengeAnswer::Forbidden);
        }
        if expires_at <= now {
            sqlx::query("DELETE FROM telegram_2fa_codes WHERE challenge = $1")
                .bind(challenge)
                .execute(&self.pool)
                .await?;
            return Ok(ChallengeAnswer::Stale);
        }
        // Повторные нажатия после решения — идемпотентны.
        if status != "pending" {
            return Ok(ChallengeAnswer::Done {
                approve: status == "approved",
                username,
            });
        }

        let new_status = if approve { "approved" } else { "denied" };
        sqlx::query("UPDATE telegram_2fa_codes SET status = $2 WHERE challenge = $1")
            .bind(challenge)
            .bind(new_status)
            .execute(&self.pool)
            .await?;
        Ok(ChallengeAnswer::Done { approve, username })
    }

    /// Подсматривает статус challenge БЕЗ удаления записи при `approved`. Нужен
    /// для сброса пароля: после подтверждения кнопкой запись должна дожить до
    /// вызова `consume_approved_challenge` с новым паролем. Завершающие отказ и
    /// истечение удаляются. `expected_purpose = Some(p)` трактует чужое
    /// назначение как `NotFound`.
    pub async fn peek_challenge(
        &self,
        challenge: &str,
        expected_purpose: Option<&str>,
    ) -> Result<ChallengeOutcome, StoreError> {
        let now = OffsetDateTime::now_utc();
        let row = sqlx::query(
            "SELECT account_uuid, expires_at, attempts, status, purpose
             FROM telegram_2fa_codes WHERE challenge = $1",
        )
        .bind(challenge)
        .fetch_optional(&self.pool)
        .await?;
        let Some(row) = row else {
            return Ok(ChallengeOutcome::NotFound);
        };

        let account_uuid: String = row.get("account_uuid");
        let expires_at: OffsetDateTime = row.get("expires_at");
        let attempts: i32 = row.get("attempts");
        let status: String = row.get("status");
        let purpose: String = row.get("purpose");

        if expected_purpose.map(|p| p != purpose).unwrap_or(false) {
            return Ok(ChallengeOutcome::NotFound);
        }
        if status == "approved" {
            // Не удаляем — запись нужна для подтверждения смены пароля.
            Ok(ChallengeOutcome::Approved(account_uuid))
        } else if status == "denied" {
            sqlx::query("DELETE FROM telegram_2fa_codes WHERE challenge = $1")
                .bind(challenge)
                .execute(&self.pool)
                .await?;
            Ok(ChallengeOutcome::Denied)
        } else if expires_at <= now || attempts >= MAX_2FA_ATTEMPTS {
            sqlx::query("DELETE FROM telegram_2fa_codes WHERE challenge = $1")
                .bind(challenge)
                .execute(&self.pool)
                .await?;
            Ok(ChallengeOutcome::Expired)
        } else {
            Ok(ChallengeOutcome::Pending)
        }
    }

    /// Завершает сценарий, требующий подтверждённого кнопкой challenge (сброс
    /// пароля): проверяет, что challenge существует, относится к `purpose`, не
    /// истёк и находится в статусе `approved`; затем удаляет его (одноразовость)
    /// и возвращает UUID аккаунта. Иначе — `NotFound`.
    pub async fn consume_approved_challenge(
        &self,
        challenge: &str,
        purpose: &str,
    ) -> Result<String, StoreError> {
        let now = OffsetDateTime::now_utc();
        let row = sqlx::query(
            "SELECT account_uuid, expires_at, status, purpose
             FROM telegram_2fa_codes WHERE challenge = $1",
        )
        .bind(challenge)
        .fetch_optional(&self.pool)
        .await?
        .ok_or(StoreError::NotFound)?;

        let account_uuid: String = row.get("account_uuid");
        let expires_at: OffsetDateTime = row.get("expires_at");
        let status: String = row.get("status");
        let row_purpose: String = row.get("purpose");

        let ok = status == "approved" && row_purpose == purpose && expires_at > now;
        // В любом случае запись больше не нужна.
        sqlx::query("DELETE FROM telegram_2fa_codes WHERE challenge = $1")
            .bind(challenge)
            .execute(&self.pool)
            .await?;
        if ok {
            Ok(account_uuid)
        } else {
            Err(StoreError::NotFound)
        }
    }

    /// Проверяет 6-значный код сброса пароля, сопоставляет IP-адрес клиента и возвращает UUID аккаунта при успехе.
    pub async fn verify_reset_challenge(
        &self,
        challenge: &str,
        code: &str,
        client_ip: &str,
    ) -> Result<String, StoreError> {
        let now = OffsetDateTime::now_utc();
        let row = sqlx::query(
            "SELECT account_uuid, code, expires_at, purpose, client_ip
             FROM telegram_2fa_codes WHERE challenge = $1",
        )
        .bind(challenge)
        .fetch_optional(&self.pool)
        .await?
        .ok_or(StoreError::NotFound)?;

        let account_uuid: String = row.get("account_uuid");
        let expected_code: String = row.get("code");
        let expires_at: OffsetDateTime = row.get("expires_at");
        let purpose: String = row.get("purpose");
        let stored_ip: Option<String> = row.get("client_ip");

        if expires_at <= now || purpose != CHALLENGE_PASSWORD_RESET {
            sqlx::query("DELETE FROM telegram_2fa_codes WHERE challenge = $1")
                .bind(challenge)
                .execute(&self.pool)
                .await?;
            return Err(StoreError::NotFound);
        }

        if stored_ip.as_deref() != Some(client_ip) {
            sqlx::query("DELETE FROM telegram_2fa_codes WHERE challenge = $1")
                .bind(challenge)
                .execute(&self.pool)
                .await?;
            return Err(StoreError::NotFound);
        }

        if !crate::constant_time_eq(code.trim().as_bytes(), expected_code.as_bytes()) {
            sqlx::query(
                "UPDATE telegram_2fa_codes SET attempts = attempts + 1 WHERE challenge = $1",
            )
            .bind(challenge)
            .execute(&self.pool)
            .await?;
            return Err(StoreError::BadPassword);
        }

        sqlx::query("DELETE FROM telegram_2fa_codes WHERE challenge = $1")
            .bind(challenge)
            .execute(&self.pool)
            .await?;

        Ok(account_uuid)
    }

    // ───────────────── Вход без пароля / сброс пароля ─────────────────

    /// Находит UUID аккаунта по нику, если у него привязан Telegram. Используется
    /// для входа без пароля и сброса пароля (по нику). `None` — нет такого
    /// аккаунта или у него не привязан Telegram (не раскрываем, что именно).
    pub async fn uuid_for_telegram_login(
        &self,
        username: &str,
    ) -> Result<Option<String>, StoreError> {
        let key = username.trim().to_lowercase();
        let uuid: Option<String> = sqlx::query_scalar(
            "SELECT uuid FROM accounts
             WHERE username_lower = $1 AND telegram_chat_id IS NOT NULL",
        )
        .bind(&key)
        .fetch_optional(&self.pool)
        .await?;
        Ok(uuid)
    }

    // ───────────────────────── Outbox ─────────────────────────

    /// Кладёт сообщение в очередь на отправку конкретному chat_id.
    pub async fn enqueue_message(&self, chat_id: &str, text: &str) -> Result<(), StoreError> {
        self.enqueue_message_full(chat_id, text, None, None).await
    }

    /// Кладёт сообщение в очередь с необязательной inline-клавиатурой
    /// (`reply_markup` — JSON Telegram Bot API).
    pub async fn enqueue_message_with_markup(
        &self,
        chat_id: &str,
        text: &str,
        reply_markup: Option<&str>,
    ) -> Result<(), StoreError> {
        self.enqueue_message_full(chat_id, text, reply_markup, None)
            .await
    }

    /// Кладёт сообщение в очередь с необязательными inline-клавиатурой и
    /// режимом разметки (`parse_mode`, например `HTML`). Если текст содержит
    /// HTML-разметку Telegram, вызывающий обязан передать `parse_mode = Some("HTML")`
    /// и сам экранировать пользовательские данные в тексте.
    pub async fn enqueue_message_full(
        &self,
        chat_id: &str,
        text: &str,
        reply_markup: Option<&str>,
        parse_mode: Option<&str>,
    ) -> Result<(), StoreError> {
        sqlx::query(
            "INSERT INTO telegram_outbox (chat_id, text, reply_markup, parse_mode) VALUES ($1, $2, $3, $4)",
        )
        .bind(chat_id)
        .bind(text)
        .bind(reply_markup)
        .bind(parse_mode)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    /// Рассылает уведомление всем админам с привязанным Telegram (фан-аут в
    /// outbox). Ошибки доставки конкретному админу не влияют на остальных.
    pub async fn notify_admins(&self, text: &str) -> Result<(), StoreError> {
        self.notify_admins_full(text, None).await
    }

    /// Рассылает уведомление всем админам с привязанным Telegram с поддержкой parse_mode.
    pub async fn notify_admins_full(&self, text: &str, parse_mode: Option<&str>) -> Result<(), StoreError> {
        let chat_ids: Vec<String> = sqlx::query_scalar(
            "SELECT telegram_chat_id FROM accounts
             WHERE role = 'admin' AND telegram_chat_id IS NOT NULL",
        )
        .fetch_all(&self.pool)
        .await?;
        for chat_id in chat_ids {
            self.enqueue_message_full(&chat_id, text, None, parse_mode).await?;
        }
        Ok(())
    }

    /// Кладёт документ в очередь на отправку.
    pub async fn enqueue_document(
        &self,
        chat_id: &str,
        caption: &str,
        doc_name: &str,
        doc_content: &[u8],
    ) -> Result<(), StoreError> {
        sqlx::query(
            "INSERT INTO telegram_outbox (chat_id, text, document_name, document_content) VALUES ($1, $2, $3, $4)",
        )
        .bind(chat_id)
        .bind(caption)
        .bind(doc_name)
        .bind(doc_content)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    /// Рассылает документ всем админам с привязанным Telegram.
    pub async fn notify_admins_with_document(&self, caption: &str, doc_name: &str, doc_content: &[u8]) -> Result<(), StoreError> {
        let chat_ids: Vec<String> = sqlx::query_scalar(
            "SELECT telegram_chat_id FROM accounts
             WHERE role = 'admin' AND telegram_chat_id IS NOT NULL",
        )
        .fetch_all(&self.pool)
        .await?;
        for chat_id in chat_ids {
            self.enqueue_document(&chat_id, caption, doc_name, doc_content).await?;
        }
        Ok(())
    }

    /// Забирает до `limit` ожидающих сообщений (для отправки ботом).
    pub async fn pending_messages(&self, limit: i64) -> Result<Vec<OutboxMessage>, StoreError> {
        let rows = sqlx::query(
            "SELECT id, chat_id, text, reply_markup, parse_mode, document_name, document_content FROM telegram_outbox
             WHERE status = 'pending' ORDER BY created_at LIMIT $1",
        )
        .bind(limit)
        .fetch_all(&self.pool)
        .await?;
        Ok(rows
            .iter()
            .map(|r| OutboxMessage {
                id: r.get("id"),
                chat_id: r.get("chat_id"),
                text: r.get("text"),
                reply_markup: r.get("reply_markup"),
                parse_mode: r.get("parse_mode"),
                document_name: r.get("document_name"),
                document_content: r.get("document_content"),
            })
            .collect())
    }

    /// Помечает сообщение как успешно отправленное.
    pub async fn mark_message_sent(&self, id: i64) -> Result<(), StoreError> {
        sqlx::query("UPDATE telegram_outbox SET status = 'sent', sent_at = now() WHERE id = $1")
            .bind(id)
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    /// Помечает попытку отправки как неуспешную. После `max_attempts`
    /// сообщение переводится в `failed`, иначе остаётся `pending` для повтора.
    pub async fn mark_message_failed(
        &self,
        id: i64,
        error: &str,
        max_attempts: i32,
    ) -> Result<(), StoreError> {
        sqlx::query(
            "UPDATE telegram_outbox
             SET attempts = attempts + 1,
                 last_error = $2,
                 status = CASE WHEN attempts + 1 >= $3 THEN 'failed' ELSE 'pending' END
             WHERE id = $1",
        )
        .bind(id)
        .bind(error)
        .bind(max_attempts)
        .execute(&self.pool)
        .await?;
        Ok(())
    }
}

/// Случайный буквенно-цифровой код (без похожих символов) заданной длины.
fn random_code(len: usize) -> String {
    const ALPHABET: &[u8] = b"ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    let mut rng = rand::thread_rng();
    (0..len)
        .map(|_| ALPHABET[rng.gen_range(0..ALPHABET.len())] as char)
        .collect()
}

/// Случайный числовой код заданной длины (для 2FA).
fn random_numeric_code(len: usize) -> String {
    let mut rng = rand::thread_rng();
    (0..len)
        .map(|_| char::from(b'0' + rng.gen_range(0..10)))
        .collect()
}

/// Экранирует спецсимволы для HTML-разметки Telegram (`parse_mode=HTML`).
/// Telegram требует экранировать только `<`, `>` и `&`.
fn html_escape(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

/// JSON inline-клавиатуры с кнопками «Это я»/«Это не я» для подтверждения
/// входа. `callback_data` = `<ok|no>:<challenge>` — бот разбирает его и зовёт
/// `answer_challenge`. Challenge состоит из `[A-Z2-9]`, экранирование не нужно.
fn approval_markup(challenge: &str) -> String {
    format!(
        r#"{{"inline_keyboard":[[{{"text":"✅ Это я","callback_data":"{ok}:{ch}"}},{{"text":"🚫 Это не я","callback_data":"{no}:{ch}"}}]]}}"#,
        ok = CALLBACK_APPROVE,
        no = CALLBACK_DENY,
        ch = challenge,
    )
}
