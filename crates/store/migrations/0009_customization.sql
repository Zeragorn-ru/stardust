-- Кастомизация ника: бейджи (эмодзи-префиксы) и градиенты (раскраска ника).

-- Бейджи — эмодзи-префиксы перед ником в TAB.
CREATE TABLE IF NOT EXISTS badges (
    id       SERIAL PRIMARY KEY,
    emoji    TEXT NOT NULL,
    label    TEXT NOT NULL,
    color    TEXT NOT NULL DEFAULT '#ffffff'
);

-- Градиенты — раскраска ника от одного цвета к другому.
CREATE TABLE IF NOT EXISTS gradients (
    id          SERIAL PRIMARY KEY,
    label       TEXT NOT NULL,
    color_start TEXT NOT NULL,
    color_end   TEXT NOT NULL
);

-- Какие бейджи доступны каждому игроку (admin назначает).
CREATE TABLE IF NOT EXISTS player_badges (
    account_uuid TEXT NOT NULL REFERENCES accounts(uuid) ON DELETE CASCADE,
    badge_id     INT NOT NULL REFERENCES badges(id) ON DELETE CASCADE,
    PRIMARY KEY (account_uuid, badge_id)
);

-- Какие градиенты доступны каждому игроку.
CREATE TABLE IF NOT EXISTS player_gradients (
    account_uuid TEXT NOT NULL REFERENCES accounts(uuid) ON DELETE CASCADE,
    gradient_id  INT NOT NULL REFERENCES gradients(id) ON DELETE CASCADE,
    PRIMARY KEY (account_uuid, gradient_id)
);

-- Выбор игрока: активный бейдж и градиент.
ALTER TABLE accounts ADD COLUMN active_badge_id    INT REFERENCES badges(id);
ALTER TABLE accounts ADD COLUMN active_gradient_id INT REFERENCES gradients(id);
