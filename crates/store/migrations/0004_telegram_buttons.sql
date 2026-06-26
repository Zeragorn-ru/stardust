-- Расширение Telegram-аутентификации: подтверждение входа кнопками
-- («Это я» / «Это не я»), вход без пароля и сброс пароля через Telegram.
--
-- Идея: таблица `telegram_2fa_codes` из миграции 0003 превращается в общий
-- «challenge»-механизм для трёх сценариев (purpose). Помимо ввода кода,
-- challenge можно подтвердить/отклонить кнопкой в Telegram — для этого
-- добавлен столбец `status`. Очередь `telegram_outbox` получает необязательный
-- `reply_markup` (inline-клавиатура), чтобы бот мог приложить кнопки к коду.

-- Назначение challenge:
--   login_2fa       — второй фактор при входе по паролю;
--   passwordless    — вход только по нику (без пароля), подтверждается в TG;
--   password_reset  — сброс забытого пароля после подтверждения в TG.
ALTER TABLE telegram_2fa_codes
    ADD COLUMN IF NOT EXISTS purpose TEXT NOT NULL DEFAULT 'login_2fa';

-- Состояние подтверждения кнопками:
--   pending  — ждём действия пользователя (или ввода кода);
--   approved — пользователь нажал «Это я» в Telegram;
--   denied   — пользователь нажал «Это не я» (попытку гасим).
ALTER TABLE telegram_2fa_codes
    ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'pending';

-- Inline-клавиатура (JSON Telegram Bot API `reply_markup`), если у сообщения
-- должны быть кнопки. NULL — обычное текстовое сообщение.
ALTER TABLE telegram_outbox
    ADD COLUMN IF NOT EXISTS reply_markup TEXT;
