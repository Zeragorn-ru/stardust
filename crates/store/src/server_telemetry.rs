use serde::{Deserialize, Serialize};
use sqlx::Row;
use time::format_description::well_known::Rfc3339;
use time::OffsetDateTime;

use crate::{Store, StoreError};
use protocol::{ExternalModAllowlistEntry, ExternalModBlockRule, ExternalModPolicy};

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

#[derive(Debug, Clone, Serialize)]
pub struct ServerLogEntry {
    pub id: i64,
    #[serde(rename = "recordedAt")]
    pub recorded_at: String,
    #[serde(rename = "eventType")]
    pub event_type: String,
    pub username: Option<String>,
    pub summary: String,
    pub details: serde_json::Value,
}

impl Store {
    pub async fn is_external_mod_allowed(
        &self,
        mod_id: &str,
        jar_name: &str,
        sha256: &str,
    ) -> Result<bool, StoreError> {
        let blocked: bool = sqlx::query_scalar(
            "SELECT EXISTS(
                SELECT 1 FROM external_mod_block_rules
                WHERE ($1 IS NOT NULL AND sha256 = $1)
                   OR ($2 <> '' AND name_substring IS NOT NULL AND position(lower(name_substring) in lower($2)) > 0)
            )",
        )
        .bind(sha256)
        .bind(jar_name)
        .fetch_one(&self.pool)
        .await?;
        if blocked {
            return Ok(false);
        }
        Ok(sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM external_mod_allowlist WHERE mod_id = $1 AND sha256 = $2)",
        )
        .bind(mod_id)
        .bind(sha256)
        .fetch_one(&self.pool)
        .await?)
    }

    pub async fn list_external_mod_allowlist(&self) -> Result<Vec<ExternalModAllowlistEntry>, StoreError> {
        let rows = sqlx::query(
            "SELECT id, mod_id, jar_name, sha256, created_at
             FROM external_mod_allowlist ORDER BY mod_id, jar_name, sha256",
        )
        .fetch_all(&self.pool)
        .await?;
        Ok(rows.into_iter().map(|row| ExternalModAllowlistEntry {
            id: row.get("id"),
            mod_id: row.get("mod_id"),
            jar_name: row.get("jar_name"),
            sha256: row.get("sha256"),
            created_at: format_recorded_at(row.get("created_at")),
        }).collect())
    }

    pub async fn add_external_mod_allowlist(
        &self,
        mod_id: &str,
        jar_name: &str,
        sha256: &str,
    ) -> Result<(), StoreError> {
        sqlx::query(
            "INSERT INTO external_mod_allowlist (mod_id, jar_name, sha256)
             VALUES ($1, $2, $3) ON CONFLICT (mod_id, sha256) DO UPDATE SET jar_name = EXCLUDED.jar_name",
        )
        .bind(mod_id)
        .bind(jar_name)
        .bind(sha256)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn remove_external_mod_allowlist(&self, id: i64) -> Result<(), StoreError> {
        sqlx::query("DELETE FROM external_mod_allowlist WHERE id = $1")
            .bind(id)
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    pub async fn list_external_mod_block_rules(&self) -> Result<Vec<ExternalModBlockRule>, StoreError> {
        let rows = sqlx::query(
            "SELECT id, sha256, name_substring, created_at
             FROM external_mod_block_rules ORDER BY id",
        )
        .fetch_all(&self.pool)
        .await?;
        Ok(rows.into_iter().map(|row| ExternalModBlockRule {
            id: row.get("id"),
            sha256: row.get("sha256"),
            name_substring: row.get("name_substring"),
            created_at: format_recorded_at(row.get("created_at")),
        }).collect())
    }

    pub async fn add_external_mod_block_rule(
        &self,
        sha256: Option<&str>,
        name_substring: Option<&str>,
    ) -> Result<(), StoreError> {
        sqlx::query(
            "INSERT INTO external_mod_block_rules (sha256, name_substring)
             VALUES ($1, $2)",
        )
        .bind(sha256)
        .bind(name_substring)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn remove_external_mod_block_rule(&self, id: i64) -> Result<(), StoreError> {
        let changed = sqlx::query("DELETE FROM external_mod_block_rules WHERE id = $1")
            .bind(id)
            .execute(&self.pool)
            .await?
            .rows_affected();
        if changed == 0 {
            return Err(StoreError::NotFound);
        }
        Ok(())
    }

    pub async fn external_mod_policy(&self) -> Result<ExternalModPolicy, StoreError> {
        Ok(ExternalModPolicy {
            allowlist: self.list_external_mod_allowlist().await?,
            block_rules: self.list_external_mod_block_rules().await?,
        })
    }

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
        self.record_server_log(
            event,
            Some(username),
            if event == "join" { "Игрок вошёл на сервер" } else { "Игрок вышел с сервера" },
            serde_json::json!({}),
        )
        .await?;
        Ok(())
    }

    pub async fn record_server_log(
        &self,
        event_type: &str,
        username: Option<&str>,
        summary: &str,
        details: serde_json::Value,
    ) -> Result<(), StoreError> {
        sqlx::query(
            "INSERT INTO server_logs (event_type, username, summary, details)
             VALUES ($1, $2, $3, $4)",
        )
        .bind(event_type)
        .bind(username)
        .bind(summary)
        .bind(details)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn server_logs_since(&self, since: OffsetDateTime) -> Result<Vec<ServerLogEntry>, StoreError> {
        let rows = sqlx::query(
            "SELECT id, recorded_at, event_type, username, summary, details
             FROM server_logs WHERE recorded_at >= $1 ORDER BY recorded_at DESC LIMIT 500",
        )
        .bind(since)
        .fetch_all(&self.pool)
        .await?;
        Ok(rows.into_iter().map(|row| ServerLogEntry {
            id: row.get("id"),
            recorded_at: format_recorded_at(row.get("recorded_at")),
            event_type: row.get("event_type"),
            username: row.get("username"),
            summary: row.get("summary"),
            details: row.get("details"),
        }).collect())
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
