CREATE TABLE IF NOT EXISTS server_logs (
    id BIGSERIAL PRIMARY KEY,
    recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    event_type TEXT NOT NULL,
    username TEXT,
    summary TEXT NOT NULL,
    details JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS server_logs_recorded_at_idx
    ON server_logs (recorded_at DESC);

CREATE INDEX IF NOT EXISTS server_logs_event_type_idx
    ON server_logs (event_type);
