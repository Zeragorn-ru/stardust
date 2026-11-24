-- API-токены для программной (MCP/скриптовой) загрузки модов в сборку.
--
-- Пароль админа и его веб-сессия для машинного доступа не годятся: у них
-- другая семантика (2FA, короткий TTL, отзыв = logout). Здесь — отдельные
-- токены, привязанные к аккаунту админа. В БД лежит только SHA-256 хеш:
-- утечка дампа не даёт готовых bearer-токенов. Полный токен показывается
-- ровно один раз при создании.
CREATE TABLE IF NOT EXISTS admin_api_tokens (
    id           BIGSERIAL PRIMARY KEY,
    -- Владелец токена. Удаление аккаунта отзывает токен каскадом.
    account_uuid TEXT NOT NULL REFERENCES accounts (uuid) ON DELETE CASCADE,
    -- Человекочитаемое имя («CI», «mod-sync agent»).
    name         TEXT NOT NULL,
    -- SHA-256 (hex) полного токена. Необратимо.
    token_hash   TEXT NOT NULL UNIQUE,
    -- Первые символы токена для списка в админке и логов (не секрет).
    token_prefix TEXT NOT NULL,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- Обновляется не чаще раза в минуту при использовании токена.
    last_used_at TIMESTAMPTZ,
    -- Отзыв: строка остаётся в аудите, но токен больше не работает.
    revoked_at   TIMESTAMPTZ,
    -- Необязательный срок действия (NULL = бессрочный, пока не отозван).
    expires_at   TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_admin_api_tokens_account
    ON admin_api_tokens (account_uuid);

-- Аудит программных загрузок: кто, каким токеном и что загрузил.
-- Отдельная таблица, потому что build_files — про содержимое сборки,
-- а не про историю действий.
CREATE TABLE IF NOT EXISTS admin_api_audit (
    id           BIGSERIAL PRIMARY KEY,
    -- NULL, если токен успели удалить (ON DELETE SET NULL); UUID и действие
    -- остаются.
    token_id     BIGINT REFERENCES admin_api_tokens (id) ON DELETE SET NULL,
    account_uuid TEXT NOT NULL,
    action       TEXT NOT NULL,
    build_id     BIGINT,
    file_id      BIGINT,
    sha1         TEXT,
    path         TEXT,
    -- Свободное поле для деталей (код ошибки, распознанный loader и т.п.).
    detail       TEXT,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_admin_api_audit_created
    ON admin_api_audit (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_admin_api_audit_account
    ON admin_api_audit (account_uuid);
