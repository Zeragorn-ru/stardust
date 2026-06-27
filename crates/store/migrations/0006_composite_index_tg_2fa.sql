-- Составной индекс для проверки cooldown 2FA: запрос ищет последний
-- pending-код аккаунта с фильтрами по status и expires_at.
CREATE INDEX IF NOT EXISTS idx_tg_2fa_account_status_expires
    ON telegram_2fa_codes (account_uuid, status, expires_at DESC, created_at DESC);
