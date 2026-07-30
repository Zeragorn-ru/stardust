CREATE TABLE IF NOT EXISTS server_telemetry_samples (
    id BIGSERIAL PRIMARY KEY,
    recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    online_count INTEGER NOT NULL,
    players JSONB NOT NULL DEFAULT '[]'::jsonb,
    tps DOUBLE PRECISION NOT NULL,
    mspt DOUBLE PRECISION NOT NULL
);

CREATE INDEX IF NOT EXISTS server_telemetry_samples_recorded_at_idx
    ON server_telemetry_samples (recorded_at);

CREATE TABLE IF NOT EXISTS server_player_events (
    id BIGSERIAL PRIMARY KEY,
    recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    username TEXT NOT NULL,
    event TEXT NOT NULL CHECK (event IN ('join', 'quit'))
);

CREATE INDEX IF NOT EXISTS server_player_events_recorded_at_idx
    ON server_player_events (recorded_at);
