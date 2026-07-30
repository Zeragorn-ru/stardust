use serde::{Deserialize, Serialize};
use sqlx::Row;
use time::format_description::well_known::Rfc3339;
use time::OffsetDateTime;

use crate::{Store, StoreError};

pub const SETTING_SERVER_TELEMETRY_TOKEN: &str = "server_telemetry_token";

#[derive(Debug, Clone, Deserialize)]
pub struct TelemetryHeartbeat {
    pub players: Vec<String>,
    pub tps: f64,
    pub mspt: f64,
}

#[derive(Debug, Clone, Serialize)]
pub struct TelemetrySample {
    #[serde(rename = "recordedAt")]
    pub recorded_at: String,
    #[serde(rename = "onlineCount")]
    pub online_count: i32,
    pub players: Vec<String>,
    pub tps: f64,
    pub mspt: f64,
}

#[derive(Debug, Clone, Serialize)]
pub struct PlayerEvent {
    #[serde(rename = "recordedAt")]
    pub recorded_at: String,
    pub username: String,
    pub event: String,
}

impl Store {
    pub async fn record_telemetry(&self, heartbeat: &TelemetryHeartbeat) -> Result<(), StoreError> {
        let players = serde_json::to_value(&heartbeat.players)
            .map_err(|e| StoreError::Backend(e.to_string()))?;
        let previous: Option<serde_json::Value> = sqlx::query_scalar(
            "SELECT players FROM server_telemetry_samples ORDER BY recorded_at DESC LIMIT 1",
        )
        .fetch_optional(&self.pool)
        .await?;
        if let Some(previous) = previous {
            let old: Vec<String> = serde_json::from_value(previous).unwrap_or_default();
            for username in heartbeat.players.iter().filter(|p| !old.contains(p)) {
                self.record_player_event(username, "join").await?;
            }
            for username in old.iter().filter(|p| !heartbeat.players.contains(p)) {
                self.record_player_event(username, "quit").await?;
            }
        } else {
            for username in &heartbeat.players {
                self.record_player_event(username, "join").await?;
            }
        }
        sqlx::query(
            "INSERT INTO server_telemetry_samples (online_count, players, tps, mspt)
             VALUES ($1, $2, $3, $4)",
        )
        .bind(heartbeat.players.len() as i32)
        .bind(players)
        .bind(heartbeat.tps.clamp(0.0, 20.0))
        .bind(heartbeat.mspt.max(0.0))
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    async fn record_player_event(&self, username: &str, event: &str) -> Result<(), StoreError> {
        sqlx::query("INSERT INTO server_player_events (username, event) VALUES ($1, $2)")
            .bind(username)
            .bind(event)
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    pub async fn telemetry_samples_since(
        &self,
        since: OffsetDateTime,
    ) -> Result<Vec<TelemetrySample>, StoreError> {
        let rows = sqlx::query(
            "SELECT recorded_at, online_count, players, tps, mspt FROM server_telemetry_samples
             WHERE recorded_at >= $1 ORDER BY recorded_at",
        )
        .bind(since)
        .fetch_all(&self.pool)
        .await?;
        rows.into_iter()
            .map(|row| {
                Ok(TelemetrySample {
                    recorded_at: format_recorded_at(row.get("recorded_at")),
                    online_count: row.get("online_count"),
                    players: serde_json::from_value(row.get("players")).unwrap_or_default(),
                    tps: row.get("tps"),
                    mspt: row.get("mspt"),
                })
            })
            .collect()
    }

    pub async fn telemetry_average_online(&self) -> Result<f64, StoreError> {
        let average: f64 = sqlx::query_scalar(
            "SELECT COALESCE(AVG(online_count), 0)::double precision FROM server_telemetry_samples",
        )
        .fetch_one(&self.pool)
        .await?;
        Ok(average)
    }

    pub async fn player_events_since(
        &self,
        since: OffsetDateTime,
    ) -> Result<Vec<PlayerEvent>, StoreError> {
        let rows = sqlx::query(
            "SELECT recorded_at, username, event FROM server_player_events
             WHERE recorded_at >= $1 ORDER BY recorded_at",
        )
        .bind(since)
        .fetch_all(&self.pool)
        .await?;
        Ok(rows
            .into_iter()
            .map(|row| PlayerEvent {
                recorded_at: format_recorded_at(row.get("recorded_at")),
                username: row.get("username"),
                event: row.get("event"),
            })
            .collect())
    }
}

fn format_recorded_at(value: OffsetDateTime) -> String {
    value.format(&Rfc3339).unwrap_or_else(|_| value.to_string())
}
