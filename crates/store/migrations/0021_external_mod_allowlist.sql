CREATE TABLE IF NOT EXISTS external_mod_allowlist (
    id BIGSERIAL PRIMARY KEY,
    mod_id TEXT NOT NULL,
    jar_name TEXT NOT NULL,
    sha256 TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (mod_id, sha256)
);

CREATE INDEX IF NOT EXISTS external_mod_allowlist_mod_idx
    ON external_mod_allowlist (mod_id);
