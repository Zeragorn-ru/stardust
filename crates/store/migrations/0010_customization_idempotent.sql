-- Безопасная повторная проверка колонок кастомизации после hotfix.
-- 0009 уже применена в проде, поэтому её текст нельзя менять: sqlx проверяет checksum.
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS active_badge_id    INT REFERENCES badges(id);
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS active_gradient_id INT REFERENCES gradients(id);
