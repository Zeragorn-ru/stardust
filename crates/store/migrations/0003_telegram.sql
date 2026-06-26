-- Интеграция с Telegram-ботом: настройки, привязка аккаунтов, 2FA и
-- очередь исходящих сообщений (outbox).
--
-- Архитектура: ни auth-server, ни admin-server не ходят в Telegram напрямую.
-- Они кладут сообщения в `telegram_outbox`, а отдельный сервис `telegram-bot`
-- (свой контейнер) забирает их и отправляет. Токен бота хранится в `settings`
-- (а не в .env), чтобы его можно было сменить из веб-админки без рестарта.

-- ─────────────────────────── Настройки ───────────────────────────
-- Простое key/value хранилище конфигурации платформы. Сейчас используется
-- для токена Telegram-бота и кэша его username.
CREATE TABLE IF NOT EXISTS settings (
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ──────────────────── Коды привязки Telegram ────────────────────
-- Одноразовый код, который игрок/админ отправляет боту командой
-- `/start <code>`. Бот находит код, узнаёт chat_id и привязывает его к
-- аккаунту. Коды короткоживущие.
CREATE TABLE IF NOT EXISTS telegram_link_tokens (
    code         TEXT PRIMARY KEY,
    account_uuid TEXT NOT NULL REFERENCES accounts (uuid) ON DELETE CASCADE,
    expires_at   TIMESTAMPTZ NOT NULL,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_tg_link_account ON telegram_link_tokens (account_uuid);

-- ──────────────────── Коды второго фактора (2FA) ────────────────────
-- При входе в лаунчер (если у аккаунта привязан Telegram) генерируется
-- числовой код, отправляется в Telegram и проверяется на шаге подтверждения.
-- `challenge` — непредсказуемый идентификатор попытки, который клиент
-- предъявляет вместе с введённым кодом.
CREATE TABLE IF NOT EXISTS telegram_2fa_codes (
    challenge    TEXT PRIMARY KEY,
    account_uuid TEXT NOT NULL REFERENCES accounts (uuid) ON DELETE CASCADE,
    code         TEXT NOT NULL,
    expires_at   TIMESTAMPTZ NOT NULL,
    attempts     INT NOT NULL DEFAULT 0,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_tg_2fa_account ON telegram_2fa_codes (account_uuid);

-- ──────────────────── Очередь исходящих сообщений ────────────────────
-- Сообщения (уведомления админам, коды 2FA, подтверждения привязки), которые
-- сервис telegram-bot отправляет в Telegram. status: pending | sent | failed.
CREATE TABLE IF NOT EXISTS telegram_outbox (
    id         BIGSERIAL PRIMARY KEY,
    chat_id    TEXT NOT NULL,
    text       TEXT NOT NULL,
    status     TEXT NOT NULL DEFAULT 'pending',
    attempts   INT NOT NULL DEFAULT 0,
    last_error TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    sent_at    TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_tg_outbox_pending
    ON telegram_outbox (created_at)
    WHERE status = 'pending';
