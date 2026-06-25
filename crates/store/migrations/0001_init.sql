-- Базовая схема платформы лаунчера.
--
-- Postgres. Слой абстракции — крейт `store`. Этой миграцией создаются
-- аккаунты, постоянные сессии и таблицы сборки (модпака).

-- ─────────────────────────── Аккаунты ───────────────────────────
CREATE TABLE IF NOT EXISTS accounts (
    uuid             TEXT PRIMARY KEY,
    username         TEXT NOT NULL,
    username_lower   TEXT NOT NULL UNIQUE,
    password_hash    TEXT NOT NULL,
    telegram_chat_id TEXT,
    role             TEXT NOT NULL DEFAULT 'user',
    skin_png         BYTEA,
    skin_model       TEXT,
    skin_sha256      TEXT,
    cape_png         BYTEA,
    cape_sha256      TEXT,
    sync_source      TEXT,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_accounts_skin_sha256 ON accounts (skin_sha256);
CREATE INDEX IF NOT EXISTS idx_accounts_cape_sha256 ON accounts (cape_sha256);
CREATE INDEX IF NOT EXISTS idx_accounts_sync_source ON accounts (sync_source);

-- ─────────────────────────── Сессии ────────────────────────────
-- Раньше жили в памяти; теперь персистятся, чтобы переживать рестарт.
CREATE TABLE IF NOT EXISTS sessions (
    token        TEXT PRIMARY KEY,
    account_uuid TEXT NOT NULL REFERENCES accounts (uuid) ON DELETE CASCADE,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_sessions_account ON sessions (account_uuid);

-- ─────────────────────────── Сборка ────────────────────────────
-- Одна активная сборка на инсталляцию (на будущее — поддержка нескольких).
CREATE TABLE IF NOT EXISTS builds (
    id          BIGSERIAL PRIMARY KEY,
    name        TEXT NOT NULL,
    version     TEXT NOT NULL,
    -- Загрузчик модов: vanilla | fabric | quilt | forge | neoforge
    loader_kind TEXT NOT NULL DEFAULT 'neoforge',
    -- Версия Minecraft, напр. 1.21.1
    mc_version  TEXT NOT NULL,
    -- Версия загрузчика модов.
    loader_version TEXT NOT NULL DEFAULT '',
    -- Активна ли сборка (которую отдаёт манифест лаунчеру).
    is_active   BOOLEAN NOT NULL DEFAULT TRUE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Файлы сборки: моды, конфиги, ресурсы. Байты лежат на диске
-- (modpack-data), здесь — метаданные и относительный путь к содержимому.
CREATE TABLE IF NOT EXISTS build_files (
    id               BIGSERIAL PRIMARY KEY,
    build_id         BIGINT NOT NULL REFERENCES builds (id) ON DELETE CASCADE,
    -- Путь относительно корня .minecraft (напр. mods/sodium.jar).
    path             TEXT NOT NULL,
    -- SHA-1 содержимого (hex) — для diff-обновления в лаунчере.
    sha1             TEXT NOT NULL,
    size_bytes       BIGINT NOT NULL,
    -- client | server | both
    side             TEXT NOT NULL DEFAULT 'both',
    -- mod | config | resource | other
    kind             TEXT NOT NULL DEFAULT 'mod',
    -- Затирать ли локальную версию при обновлении (конфиги: false).
    overwrite        BOOLEAN NOT NULL DEFAULT TRUE,
    -- Опциональный мод (включается/выключается игроком в лаунчере).
    optional         BOOLEAN NOT NULL DEFAULT FALSE,
    -- Включён ли опциональный мод по умолчанию.
    enabled_by_default BOOLEAN NOT NULL DEFAULT TRUE,
    -- Стабильный id опционального мода (modid/slug) для хранения выбора игрока.
    mod_id           TEXT,
    display_name     TEXT,
    description      TEXT,
    -- Имя файла содержимого в хранилище modpack-data (обычно = sha1).
    storage_key      TEXT NOT NULL,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (build_id, path)
);

CREATE INDEX IF NOT EXISTS idx_build_files_build ON build_files (build_id);
