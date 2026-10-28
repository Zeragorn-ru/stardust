-- auth-server разбирает свежий краш СРАЗУ (игрок ждёт вердикт на экране)
-- и помечает запись ai_status='pending' на время разбора, чтобы фоновый
-- воркер admin-server не анализировал её повторно.
--
-- Индекс пересоздаётся под новое условие — 0029 уже применена на проде,
-- менять её нельзя.
--
-- ВАЖНО: предикат частичного индекса допускает только IMMUTABLE-выражения,
-- поэтому now()/INTERVAL здесь НЕЛЬЗЯ (now() — STABLE → «functions in index
-- predicate must be marked IMMUTABLE», миграция падает). Отсечку «зависший
-- pending старше 30 минут» делает запрос pending_crashes (в SELECT STABLE
-- разрешён); индекс лишь сужает множество до необработанных крашей.
DROP INDEX IF EXISTS server_logs_crash_ai_idx;

CREATE INDEX server_logs_crash_ai_idx
    ON server_logs (id)
    WHERE event_type IN ('client_crash', 'server_crash')
      AND (ai_status IS NULL OR ai_status = 'pending');
