CREATE TABLE IF NOT EXISTS external_mod_block_rules (
    id BIGSERIAL PRIMARY KEY,
    sha256 TEXT,
    name_substring TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT external_mod_block_rules_condition_check
        CHECK (sha256 IS NOT NULL OR name_substring IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS external_mod_block_rules_sha256_idx
    ON external_mod_block_rules (sha256)
    WHERE sha256 IS NOT NULL;

CREATE INDEX IF NOT EXISTS external_mod_block_rules_name_idx
    ON external_mod_block_rules (name_substring)
    WHERE name_substring IS NOT NULL;
