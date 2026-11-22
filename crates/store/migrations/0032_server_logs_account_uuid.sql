-- История крашей жёстко привязана к нику, а ник изменяем: после смены ника
-- (своей или админской) старые записи server_logs остаются с прежним ником и
-- пропадают из ленты игрока, а освободившийся ник получает их же вместе с
-- AI-вердиктами (в вердикте — окружение чужой машины).
--
-- Добавляем account_uuid рядом с username: ник оставляем для отображения и
-- старых потребителей, но выборки игрока идут по uuid.
--
-- Бэкфилл — только точное совпадение ника: при смене ника старую запись к
-- аккаунту привязать нечем, а совпадение по lower() после освобождения ника
-- привязало бы чужие краши к новому владельцу (ровно та утечка, которую
-- закрываем). Непривязанные старые записи остаются историей админки.
--
-- Дополнительно требуем, чтобы аккаунт существовал на момент краша: краш
-- раньше регистрации ника означает, что ник тогда принадлежал другому
-- аккаунту (смена + повторная регистрация), и привязка была бы ложной.
--
-- FK с ON DELETE SET NULL: удаление аккаунта не должно трогать журнал (это
-- журнал сервера, и строки нужны админке), но и висеть на удалённом uuid не
-- должны.
ALTER TABLE server_logs ADD COLUMN IF NOT EXISTS account_uuid TEXT;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'server_logs_account_uuid_fkey'
    ) THEN
        ALTER TABLE server_logs
            ADD CONSTRAINT server_logs_account_uuid_fkey
            FOREIGN KEY (account_uuid) REFERENCES accounts (uuid) ON DELETE SET NULL;
    END IF;
END
$$;

UPDATE server_logs l
SET account_uuid = a.uuid
FROM accounts a
WHERE l.account_uuid IS NULL
  AND l.username IS NOT NULL
  AND a.username = l.username
  AND a.created_at <= l.recorded_at;

-- Лента игрока: фильтр (event_type, account_uuid) + ORDER BY id DESC LIMIT 50.
-- Частичный индекс — только краши, остальные события ленту не обслуживают.
CREATE INDEX IF NOT EXISTS server_logs_account_crash_idx
    ON server_logs (account_uuid, id DESC)
    WHERE event_type = 'client_crash' AND account_uuid IS NOT NULL;
