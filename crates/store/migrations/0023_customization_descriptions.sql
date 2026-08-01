-- Описания косметики для hover-подсказок в Minecraft-чате.
ALTER TABLE badges
    ADD COLUMN IF NOT EXISTS description TEXT NOT NULL DEFAULT '';

ALTER TABLE gradients
    ADD COLUMN IF NOT EXISTS description TEXT NOT NULL DEFAULT '';
