-- AI-анализ крашей: статус обработки и вердикт хранятся рядом с записью
-- журнала. ai_analysis — JSONB: {summary, cause, suggestion, severity,
-- model, analyzedAt, error?}.
ALTER TABLE server_logs ADD COLUMN IF NOT EXISTS ai_status TEXT;
ALTER TABLE server_logs ADD COLUMN IF NOT EXISTS ai_analysis JSONB;

-- Воркер берёт необработанные краши пачкой: индекс по (event_type, ai_status).
CREATE INDEX IF NOT EXISTS server_logs_crash_ai_idx
    ON server_logs (id)
    WHERE event_type IN ('client_crash', 'server_crash') AND ai_status IS NULL;
