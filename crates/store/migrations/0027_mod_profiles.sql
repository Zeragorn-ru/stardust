-- Профили опциональных модов: пресеты «Производительность»/«Качество»
-- внутри ОДНОЙ сборки, без вторых подсборок. Сборка публикует мета-список
-- профилей, а каждый опциональный файл помечается, в каких профилях он
-- состоит (пусто = «общий», есть во всех).

CREATE TABLE IF NOT EXISTS build_mod_profiles (
    id          BIGSERIAL PRIMARY KEY,
    build_id    BIGINT NOT NULL REFERENCES builds (id) ON DELETE CASCADE,
    -- Стабильный ключ профиля (используется в build_files.profile_keys
    -- и в выборе игрока).
    key         TEXT NOT NULL,
    name        TEXT NOT NULL,
    description TEXT,
    sort_order  INT NOT NULL DEFAULT 0,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (build_id, key)
);

ALTER TABLE build_files
    ADD COLUMN IF NOT EXISTS profile_keys TEXT[] NOT NULL DEFAULT '{}';

CREATE INDEX IF NOT EXISTS idx_build_mod_profiles_build
    ON build_mod_profiles (build_id);
