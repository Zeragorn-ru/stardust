-- auth-server разбирает свежий краш СРАЗУ (игрок ждёт вердикт на экране)
-- и помечает запись ai_status='pending' на время разбора, чтобы фоновый
-- воркер admin-server не анализировал её повторно.
--
-- Воркер берёт: записи без статуса ИЛИ зависший 'pending' старше 30 минут
-- (если auth-server упал посреди разбора). Индекс пересоздаётся под новое
-- условие — 0029 уже применена на проде, менять её нельзя.
DROP INDEX IF EXISTS server_logs_crash_ai_idx;

CREATE INDEX server_logs_crash_ai_idx
    ON server_logs (id)
    WHERE event_type IN ('client_crash', 'server_crash')
      AND (ai_status IS NULL
           OR (ai_status = 'pending' AND recorded_at < now() - INTERVAL '30 minutes'));
