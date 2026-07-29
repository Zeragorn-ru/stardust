-- Сохранение времени последней прочитанной новости для синхронизации между устройствами и перезаходами.
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS news_seen_at TEXT;
