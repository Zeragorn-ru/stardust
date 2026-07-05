-- Добавление столбца client_ip для записи IP-адреса клиента, инициировавшего сброс пароля или вход.
ALTER TABLE telegram_2fa_codes
    ADD COLUMN IF NOT EXISTS client_ip TEXT;
