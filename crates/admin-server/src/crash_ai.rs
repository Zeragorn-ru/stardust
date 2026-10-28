//! Клей AI-анализа крашей для admin-server.
//!
//! Ядро (провайдер, промпт, парсинг вердикта) живёт в общем крейте
//! `crash-ai` — его использует и auth-server (срочный разбор по горячим
//! следам для игрока). Здесь — фоновый воркер по необработанным записям,
//! чтение конфигурации из settings, уведомление админов и ручной запуск.

pub use crash_ai::{Failure, Verdict};
use crash_ai::{admin_notification, analyze, Config, CrashInput};
use store::server_telemetry::PendingCrash;

/// Сколько необработанных крашей берёт воркер за один проход.
const BATCH_LIMIT: i64 = 5;

/// Конфигурация провайдера из settings (обёртка над общей `crash_ai::load_config`).
pub async fn load_config(state: &crate::Shared) -> Result<Option<Config>, String> {
    crash_ai::load_config(&state.store).await
}

/// Один проход фонового воркера: берёт пачку крашей без вердикта и
/// анализирует каждый. Возвращает число обработанных записей.
///
/// Ошибка конфигурации (не настроен/выключен) — не ошибка: воркер просто
/// ничего не делает. Ошибка отдельного анализа пишется в саму запись
/// (`ai_status = failed`), чтобы не зацикливать ретраи навсегда.
pub async fn analyze_pending(state: &crate::Shared) -> Result<usize, String> {
    let config = match load_config(state).await? {
        Some(config) => config,
        None => return Ok(0),
    };

    let crashes = state
        .store
        .pending_crashes(BATCH_LIMIT)
        .await
        .map_err(|e| format!("выборка крашей: {e}"))?;
    if crashes.is_empty() {
        return Ok(0);
    }

    let mut analyzed = 0usize;
    for crash in crashes {
        match run_analysis(state, &config, &crash).await {
            Ok(verdict) => {
                notify_admins(state, &crash, &verdict).await;
                analyzed += 1;
            }
            Err(error) => tracing::warn!("[crash-ai] анализ #{} не удался: {error}", crash.id),
        }
    }
    Ok(analyzed)
}

/// Ручной (пере)анализ одной записи: вызывает провайдера и пишет вердикт.
/// Используется роутом `POST /api/server/logs/:id/analyze`.
pub async fn analyze_log(state: &crate::Shared, id: i64) -> Result<Verdict, String> {
    let config = load_config(state)
        .await?
        .ok_or_else(|| "AI-анализ не настроен или выключен".to_string())?;
    let crash = state
        .store
        .server_log(id)
        .await
        .map_err(|e| format!("журнал #{id}: {e}"))?;
    if !matches!(crash.event_type.as_str(), "client_crash" | "server_crash") {
        return Err("это событие не является крашем".to_string());
    }
    let pending = PendingCrash {
        id: crash.id,
        event_type: crash.event_type,
        username: crash.username,
        summary: crash.summary,
        details: crash.details,
    };
    let verdict = run_analysis(state, &config, &pending).await?;
    notify_admins(state, &pending, &verdict).await;
    Ok(verdict)
}

/// Общий шаг: провайдер → запись вердикта/ошибки в server_logs.
async fn run_analysis(
    state: &crate::Shared,
    config: &Config,
    crash: &PendingCrash,
) -> Result<Verdict, String> {
    let input = CrashInput {
        id: crash.id,
        event_type: crash.event_type.clone(),
        username: crash.username.clone(),
        summary: crash.summary.clone(),
        details: crash.details.clone(),
    };
    match analyze(&state.http, config, &input).await {
        Ok(verdict) => {
            let json = serde_json::to_value(&verdict).unwrap_or_default();
            state
                .store
                .set_crash_ai(crash.id, "done", &json)
                .await
                .map_err(|e| format!("запись вердикта #{}: {e}", crash.id))?;
            Ok(verdict)
        }
        Err(error) => {
            let failure = Failure::new(error.clone());
            let json = serde_json::to_value(&failure).unwrap_or_default();
            if let Err(e) = state.store.set_crash_ai(crash.id, "failed", &json).await {
                tracing::warn!("[crash-ai] запись ошибки #{}: {e}", crash.id);
            }
            Err(error)
        }
    }
}

/// Короткое уведомление админам в Telegram с вердиктом.
async fn notify_admins(state: &crate::Shared, crash: &PendingCrash, verdict: &Verdict) {
    let text = admin_notification(crash.id, crash.username.as_deref(), verdict);
    if let Err(e) = state.store.notify_admins(&text).await {
        tracing::warn!("[crash-ai] уведомление админов: {e}");
    }
}
