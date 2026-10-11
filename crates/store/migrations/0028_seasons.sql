-- Сезоны и архив статистики.
-- Модель сезонов: живая статистика игроков (playtime_seconds, deaths,
-- blocks_mined, distance_cm на аккаунтах) всегда принадлежит текущему
-- АКТИВНОМУ сезону. При архивации делается снимок всех аккаунтов в
-- season_accounts, старый сезон закрывается (status = archived,
-- ended_at = now), открывается новый с обнулёнными счётчиками аккаунтов.
-- Так история топов сохраняется навсегда, а лидерборды «сейчас»
-- показывают только текущий сезон.
CREATE TABLE IF NOT EXISTS seasons (
    id        INTEGER PRIMARY KEY,
    name      TEXT NOT NULL,
    status    TEXT NOT NULL CHECK (status IN ('active', 'archived')),
    started_at TIMESTAMPTZ,
    ended_at   TIMESTAMPTZ
);

-- Снимок статистики игроков на момент закрытия сезона. uuid/username
-- хранятся снимком: аккаунт может быть переименован или удалён после
-- архивации, но топ сезона меняться не должен.
CREATE TABLE IF NOT EXISTS season_accounts (
    season_id       INTEGER NOT NULL REFERENCES seasons(id) ON DELETE CASCADE,
    uuid            TEXT NOT NULL,
    username        TEXT NOT NULL,
    username_lower  TEXT NOT NULL,
    playtime_seconds BIGINT NOT NULL DEFAULT 0,
    deaths           BIGINT NOT NULL DEFAULT 0,
    blocks_mined     BIGINT NOT NULL DEFAULT 0,
    distance_cm      BIGINT NOT NULL DEFAULT 0,
    last_joined_at   TIMESTAMPTZ,
    PRIMARY KEY (season_id, uuid)
);

CREATE INDEX IF NOT EXISTS idx_season_accounts_name
    ON season_accounts (season_id, username_lower);

-- Первый сезон: активный, статистика до этого момента считается его.
INSERT INTO seasons (id, name, status, started_at, ended_at)
VALUES (1, 'Сезон 1', 'active', NULL, NULL)
ON CONFLICT (id) DO NOTHING;
