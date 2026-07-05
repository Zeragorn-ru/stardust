-- Разрешить удалять бейджи даже если они активны у игроков:
-- при удалении бейджа active_badge_id ставится в NULL (без бейджа).
ALTER TABLE accounts
    DROP CONSTRAINT IF EXISTS accounts_active_badge_id_fkey;

ALTER TABLE accounts
    ADD CONSTRAINT accounts_active_badge_id_fkey
    FOREIGN KEY (active_badge_id) REFERENCES badges(id) ON DELETE SET NULL;

-- То же для градиентов на будущее
ALTER TABLE accounts
    DROP CONSTRAINT IF EXISTS accounts_active_gradient_id_fkey;

ALTER TABLE accounts
    ADD CONSTRAINT accounts_active_gradient_id_fkey
    FOREIGN KEY (active_gradient_id) REFERENCES gradients(id) ON DELETE SET NULL;
