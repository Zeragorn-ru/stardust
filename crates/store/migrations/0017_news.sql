-- Новости лаунчера. Автор хранится снимком имени, чтобы история не менялась
-- после переименования или удаления учётной записи администратора.
CREATE TABLE IF NOT EXISTS news_posts (
    id          BIGSERIAL PRIMARY KEY,
    title       TEXT NOT NULL,
    markdown    TEXT NOT NULL,
    author_name TEXT NOT NULL,
    pinned      BOOLEAN NOT NULL DEFAULT FALSE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_news_posts_feed
    ON news_posts (pinned DESC, updated_at DESC);
