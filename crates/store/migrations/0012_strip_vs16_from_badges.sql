-- Убирает Variation Selector 16 (U+FE0F) из эмодзи бейджей.
-- Minecraft не понимает VS16 и отображает его как видимый символ "□".
UPDATE badges SET emoji = replace(emoji, E'\uFE0F', '') WHERE emoji != replace(emoji, E'\uFE0F', '');
