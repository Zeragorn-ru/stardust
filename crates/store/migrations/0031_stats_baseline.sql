-- Baseline lifetime-статистики на момент начала сезона.
-- Minecraft отдаёт lifetime-счётчики (за всё время жизни игрока), а живые
-- playtime_seconds/deaths/blocks_mined/distance_cm на аккаунтах должны
-- показывать текущий сезон. При архивации сезона live-счётчики обнуляются,
-- но следующий SFTP-тик синхронизации без baseline вернул бы lifetime
-- целиком и мгновенно отменил сброс.
--
-- Схема: live = lifetime - baseline (в тех же единицах, что live-колонки).
--   * baseline пишется при архивации (= lifetime на момент снимка);
--   * синхронизация обновляет lifetime := GREATEST(lifetime, присланное)
--     и live := lifetime - baseline;
--   * для игроков, зарегистрированных после начала сезона, baseline = 0
--     (lifetime и есть сезонная статистика).
ALTER TABLE accounts
    ADD COLUMN IF NOT EXISTS lifetime_playtime_seconds BIGINT NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS lifetime_deaths BIGINT NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS lifetime_blocks_mined BIGINT NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS lifetime_distance_cm BIGINT NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS baseline_playtime_seconds BIGINT NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS baseline_deaths BIGINT NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS baseline_blocks_mined BIGINT NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS baseline_distance_cm BIGINT NOT NULL DEFAULT 0;

-- Существующие игроки: их текущий live — это lifetime до внедрения схемы
-- (GREATEST-синхронизация уже писала lifetime как live). Инициализируем
-- lifetime := live, baseline остаётся 0 — инвариант live = lifetime -
-- baseline выполняется сразу после миграции.
UPDATE accounts
SET lifetime_playtime_seconds = playtime_seconds,
    lifetime_deaths = deaths,
    lifetime_blocks_mined = blocks_mined,
    lifetime_distance_cm = distance_cm;
