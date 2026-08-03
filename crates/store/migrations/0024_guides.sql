-- Публичные гайды сообщества, редактируемые из админ-панели.
CREATE TABLE IF NOT EXISTS guides (
    id          BIGSERIAL PRIMARY KEY,
    slug        TEXT NOT NULL UNIQUE,
    title       TEXT NOT NULL,
    excerpt     TEXT NOT NULL DEFAULT '',
    category    TEXT NOT NULL DEFAULT 'Общее',
    markdown    TEXT NOT NULL,
    author_name TEXT NOT NULL,
    published   BOOLEAN NOT NULL DEFAULT FALSE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_guides_public_feed
    ON guides (published DESC, updated_at DESC);
