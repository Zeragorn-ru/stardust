CREATE TABLE IF NOT EXISTS coin_ledger (
    id BIGSERIAL PRIMARY KEY,
    account_uuid TEXT NOT NULL REFERENCES accounts(uuid) ON DELETE CASCADE,
    amount BIGINT NOT NULL CHECK (amount <> 0),
    reason TEXT NOT NULL,
    idempotency_key TEXT NOT NULL UNIQUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_coin_ledger_account_created
    ON coin_ledger (account_uuid, created_at DESC);

CREATE TABLE IF NOT EXISTS achievements (
    id BIGSERIAL PRIMARY KEY,
    slug TEXT NOT NULL UNIQUE,
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    coin_reward BIGINT NOT NULL CHECK (coin_reward >= 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS account_achievements (
    account_uuid TEXT NOT NULL REFERENCES accounts(uuid) ON DELETE CASCADE,
    achievement_id BIGINT NOT NULL REFERENCES achievements(id) ON DELETE CASCADE,
    granted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (account_uuid, achievement_id)
);
