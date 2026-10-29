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
pub struct ServerLogSummary {
    pub id: i64,
    #[serde(rename = "recordedAt")]
    pub recorded_at: String,
    #[serde(rename = "eventType")]
    pub event_type: String,
    pub username: Option<String>,
    pub summary: String,
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
    /// Статус AI-анализа: `pending` / `done` / `failed` / `None` (не краш или
    /// анализ выключен).
    #[serde(rename = "aiStatus", skip_serializing_if = "Option::is_none")]
    pub ai_status: Option<String>,
    /// Вердикт AI-анализа (JSONB), если готов.
    #[serde(rename = "aiAnalysis", skip_serializing_if = "Option::is_none")]
    pub ai_analysis: Option<serde_json::Value>,
}

/// Краш, ожидающий AI-анализа. Воркер берёт пачку таких и прогоняет через
/// провайдера; `details` — сырой JSONB журнала (логи, стек, моды).
#[derive(Debug, Clone)]
pub struct PendingCrash {
    pub id: i64,
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

    pub async fn list_external_mod_allowlist(
        &self,
    ) -> Result<Vec<ExternalModAllowlistEntry>, StoreError> {
        let rows = sqlx::query(
            "SELECT id, mod_id, jar_name, sha256, created_at
             FROM external_mod_allowlist ORDER BY mod_id, jar_name, sha256",
        )
        .fetch_all(&self.pool)
        .await?;
        Ok(rows
            .into_iter()
            .map(|row| ExternalModAllowlistEntry {
                id: row.get("id"),
                mod_id: row.get("mod_id"),
                jar_name: row.get("jar_name"),
                sha256: row.get("sha256"),
                created_at: format_recorded_at(row.get("created_at")),
            })
            .collect())
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

    pub async fn list_external_mod_block_rules(
        &self,
    ) -> Result<Vec<ExternalModBlockRule>, StoreError> {
        let rows = sqlx::query(
            "SELECT id, sha256, name_substring, created_at
             FROM external_mod_block_rules ORDER BY id",
        )
        .fetch_all(&self.pool)
        .await?;
        Ok(rows
            .into_iter()
            .map(|row| ExternalModBlockRule {
                id: row.get("id"),
                sha256: row.get("sha256"),
                name_substring: row.get("name_substring"),
                created_at: format_recorded_at(row.get("created_at")),
            })
            .collect())
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
            if event == "join" {
                "Игрок вошёл на сервер"
            } else {
                "Игрок вышел с сервера"
            },
            serde_json::json!({}),
        )
        .await?;
        Ok(())
    }

    /// Пишет запись журнала и возвращает её id (нужен auth-server'у, чтобы
    /// отдать его лаунчеру для опроса AI-разбора краша).
    pub async fn record_server_log(
        &self,
        event_type: &str,
        username: Option<&str>,
        summary: &str,
        details: serde_json::Value,
    ) -> Result<i64, StoreError> {
        let id: i64 = sqlx::query_scalar(
            "INSERT INTO server_logs (event_type, username, summary, details)
             VALUES ($1, $2, $3, $4) RETURNING id",
        )
        .bind(event_type)
        .bind(username)
        .bind(summary)
        .bind(details)
        .fetch_one(&self.pool)
        .await?;
        Ok(id)
    }

    pub async fn server_log_summaries_since(
        &self,
        since: OffsetDateTime,
    ) -> Result<Vec<ServerLogSummary>, StoreError> {
        let rows = sqlx::query(
            "SELECT id, recorded_at, event_type, username, summary
             FROM server_logs WHERE recorded_at >= $1 ORDER BY recorded_at DESC LIMIT 500",
        )
        .bind(since)
        .fetch_all(&self.pool)
        .await?;
        Ok(rows
            .into_iter()
            .map(|row| ServerLogSummary {
                id: row.get("id"),
                recorded_at: format_recorded_at(row.get("recorded_at")),
                event_type: row.get("event_type"),
                username: row.get("username"),
                summary: row.get("summary"),
            })
            .collect())
    }

    pub async fn server_log(&self, id: i64) -> Result<ServerLogEntry, StoreError> {
        let row = sqlx::query(
            "SELECT id, recorded_at, event_type, username, summary, details, ai_status, ai_analysis
             FROM server_logs WHERE id = $1",
        )
        .bind(id)
        .fetch_optional(&self.pool)
        .await?
        .ok_or(StoreError::NotFound)?;
        Ok(ServerLogEntry {
            id: row.get("id"),
            recorded_at: format_recorded_at(row.get("recorded_at")),
            event_type: row.get("event_type"),
            username: row.get("username"),
            summary: row.get("summary"),
            details: row.get("details"),
            ai_status: row.get("ai_status"),
            ai_analysis: row.get("ai_analysis"),
        })
    }

    /// История крашей ОДНОГО игрока (для экрана «История крашей» в лаунчере).
    /// Без полных логов (details): список лёгкий, вердикт AI прилагается.
    /// Свежие сверху, не более `limit`.
    pub async fn crash_history_for(
        &self,
        username: &str,
        limit: i64,
    ) -> Result<Vec<ServerLogEntry>, StoreError> {
        let rows = sqlx::query(
            "SELECT id, recorded_at, event_type, username, summary, '{}'::jsonb AS details,
                    ai_status, ai_analysis
             FROM server_logs
             WHERE event_type = 'client_crash' AND username = $1
             ORDER BY id DESC LIMIT $2",
        )
        .bind(username)
        .bind(limit)
        .fetch_all(&self.pool)
        .await?;
        Ok(rows
            .into_iter()
            .map(|row| ServerLogEntry {
                id: row.get("id"),
                recorded_at: format_recorded_at(row.get("recorded_at")),
                event_type: row.get("event_type"),
                username: row.get("username"),
                summary: row.get("summary"),
                details: row.get("details"),
                ai_status: row.get("ai_status"),
                ai_analysis: row.get("ai_analysis"),
            })
            .collect())
    }

    /// Краши без AI-вердикта (для фонового воркера). Берём только свежие —
    /// анализ старых записей после включения настройки не нужен и дорог.
    ///
    /// Условие совпадает с индексом server_logs_crash_ai_idx (миграция 0030):
    /// записи без статуса ИЛИ зависший 'pending' старше 30 минут (auth-server
    /// упал посреди немедленного разбора). Активный 'pending' не трогаем —
    /// его разбирает auth-server прямо сейчас.
    pub async fn pending_crashes(&self, limit: i64) -> Result<Vec<PendingCrash>, StoreError> {
        let rows = sqlx::query(
            "SELECT id, event_type, username, summary, details FROM server_logs
             WHERE event_type IN ('client_crash', 'server_crash')
               AND (ai_status IS NULL
                    OR (ai_status = 'pending' AND recorded_at < now() - INTERVAL '30 minutes'))
               AND recorded_at >= now() - INTERVAL '7 days'
             ORDER BY id LIMIT $1",
        )
        .bind(limit)
        .fetch_all(&self.pool)
        .await?;
        Ok(rows
            .into_iter()
            .map(|row| PendingCrash {
                id: row.get("id"),
                event_type: row.get("event_type"),
                username: row.get("username"),
                summary: row.get("summary"),
                details: row.get("details"),
            })
            .collect())
    }

    /// Пишет результат AI-анализа (`status` = done/failed, `analysis` = вердикт
    /// или `{error}`). Возвращает Err(NotFound), если записи уже нет.
    pub async fn set_crash_ai(
        &self,
        id: i64,
        status: &str,
        analysis: &serde_json::Value,
    ) -> Result<(), StoreError> {
        let result = sqlx::query("UPDATE server_logs SET ai_status = $2, ai_analysis = $3 WHERE id = $1")
            .bind(id)
            .bind(status)
            .bind(analysis)
            .execute(&self.pool)
            .await?;
        if result.rows_affected() == 0 {
            return Err(StoreError::NotFound);
        }
        Ok(())
    }

    /// Сбрасывает AI-статус записи, чтобы воркер (или ручной запуск)
    /// проанализировал её заново.
    pub async fn reset_crash_ai(&self, id: i64) -> Result<(), StoreError> {
        sqlx::query("UPDATE server_logs SET ai_status = NULL, ai_analysis = NULL WHERE id = $1")
            .bind(id)
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

    /// Ретеншн телеметрии: срезы онлайн-статистики и события игроков
    /// старше 30 дней, журналы сервера старше 90 дней. Без этой чистки
    /// таблицы и ответы /api/server/telemetry растут бесконечно —
    /// record_telemetry пишет новые строки каждое сердцебиение сервера.
    pub async fn purge_old_telemetry(&self) -> Result<u64, StoreError> {
        let mut changed = 0u64;
        for (table, days) in [
            ("server_telemetry_samples", 30i32),
            ("server_player_events", 30),
            ("server_logs", 90),
        ] {
            let sql = format!(
                "DELETE FROM {table} WHERE recorded_at < now() - ($1 || ' days')::interval"
            );
            let res = sqlx::query(&sql)
                .bind(days.to_string())
                .execute(&self.pool)
                .await?;
            changed += res.rows_affected();
        }
        Ok(changed)
    }
}

fn format_recorded_at(value: OffsetDateTime) -> String {
    value.format(&Rfc3339).unwrap_or_else(|_| value.to_string())
}
