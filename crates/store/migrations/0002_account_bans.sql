-- Блокировки аккаунтов (баны) для управления игроками из админки.
--
-- Модель:
--   banned = false                      → активен;
--   banned = true,  banned_until = NULL → бан навсегда;
--   banned = true,  banned_until = ts   → временный бан до `ts`
--                                         (после истечения считается снятым).

ALTER TABLE accounts
    ADD COLUMN IF NOT EXISTS banned       BOOLEAN     NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS banned_until TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS ban_reason   TEXT;
