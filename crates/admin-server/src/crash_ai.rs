//! AI-анализ крашей Minecraft.
//!
//! Краши (`client_crash` / `server_crash` в `server_logs`) уже собираются
//! auth-server'ом со всеми логами. Этот модуль прогоняет их через
//! OpenAI-совместимый chat-completions API и пишет вердикт обратно в
//! журнал (`ai_status` / `ai_analysis`), плюс дублирует краткий вывод
//! админам в Telegram.
//!
//! Провайдер настраивается в админке (settings): базовый URL, модель,
//! API-ключ, вкл/выкл. Любой OpenAI-совместимый endpoint: OpenAI,
//! OpenRouter, локальная vLLM/Ollama и т.п.

use std::time::Duration;

use reqwest::Client;
use serde::{Deserialize, Serialize};
use time::format_description::well_known::Rfc3339;
use time::OffsetDateTime;

use store::server_telemetry::PendingCrash;

/// Конфигурация провайдера (из settings админки).
#[derive(Clone, Debug)]
pub struct Config {
    /// Базовый URL API без пути (`https://api.openai.com/v1`).
    pub endpoint: String,
    /// Имя модели (`gpt-4o-mini` и т.п.).
    pub model: String,
    /// API-ключ (Bearer).
    pub api_key: String,
}

/// Вердикт анализа в том виде, в каком он хранится в `ai_analysis`.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Verdict {
    /// Короткое резюме (1–2 предложения) — что произошло.
    pub summary: String,
    /// Вероятная причина (мод, драйвер, память, конфиг и т.п.).
    pub cause: String,
    /// Что сделать игроку/админу.
    pub suggestion: String,
    /// `low` / `medium` / `high` / `critical`.
    pub severity: String,
    /// Модель, давшая вердикт.
    pub model: String,
    /// Когда проанализировано (RFC 3339).
    pub analyzed_at: String,
}

/// Ошибка анализа (хранится в `ai_analysis.error` при `ai_status = failed`).
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Failure {
    pub error: String,
    pub analyzed_at: String,
}

/// Таймаут одного запроса к провайдеру: краш-репорты большие, ответ
/// генерируется долго, но вечно ждать нельзя (воркер последовательный).
const REQUEST_TIMEOUT: Duration = Duration::from_secs(120);

/// Максимум символов одного краша, отправляемых модели. Полные debug.log
/// бывают на мегабайты — режем хвост каждого файла, оставляя голову
/// (в начале — запуск и конфигурация) и хвост (последние строки перед
/// падением самые диагностические).
const MAX_LOG_CHARS: usize = 24_000;

/// Сколько необработанных крашей берёт воркер за один проход.
const BATCH_LIMIT: i64 = 5;

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
        match analyze_one(&state.http, &config, &crash).await {
            Ok(verdict) => {
                let json = serde_json::to_value(&verdict).unwrap_or_default();
                if let Err(e) = state.store.set_crash_ai(crash.id, "done", &json).await {
                    tracing::warn!("[crash-ai] запись вердикта #{}: {e}", crash.id);
                    continue;
                }
                notify_admins(state, &crash, &verdict).await;
                analyzed += 1;
            }
            Err(error) => {
                let failure = Failure {
                    error: error.clone(),
                    analyzed_at: now_rfc3339(),
                };
                let json = serde_json::to_value(&failure).unwrap_or_default();
                if let Err(e) = state.store.set_crash_ai(crash.id, "failed", &json).await {
                    tracing::warn!("[crash-ai] запись ошибки #{}: {e}", crash.id);
                }
                tracing::warn!("[crash-ai] анализ #{} не удался: {error}", crash.id);
            }
        }
    }
    Ok(analyzed)
}

/// Ручной (пере)анализ одной записи: сбрасывает статус, вызывает провайдера,
/// пишет вердикт. Используется роутом `POST /api/server/logs/:id/analyze`.
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
    let verdict = analyze_one(&state.http, &config, &pending).await?;
    let json = serde_json::to_value(&verdict).map_err(|e| format!("сериализация: {e}"))?;
    state
        .store
        .set_crash_ai(id, "done", &json)
        .await
        .map_err(|e| format!("запись вердикта: {e}"))?;
    notify_admins(state, &pending, &verdict).await;
    Ok(verdict)
}

/// Читает конфигурацию провайдера из settings. `None` — анализ выключен
/// или настроен не полностью (нет endpoint/ключа); это нормальное состояние.
pub async fn load_config(state: &crate::Shared) -> Result<Option<Config>, String> {
    let keys = [
        store::SETTING_CRASH_AI_ENABLED,
        store::SETTING_CRASH_AI_ENDPOINT,
        store::SETTING_CRASH_AI_MODEL,
        store::SETTING_CRASH_AI_API_KEY,
    ];
    let map = state
        .store
        .get_settings_batch(&keys)
        .await
        .map_err(|e| format!("настройки: {e}"))?;
    let get = |key: &str| {
        map.get(key)
            .and_then(|v| v.as_ref())
            .map(|v| v.trim().to_string())
    };

    let enabled = get(store::SETTING_CRASH_AI_ENABLED).is_some_and(|v| v == "1");
    if !enabled {
        return Ok(None);
    }
    let endpoint = get(store::SETTING_CRASH_AI_ENDPOINT).filter(|v| !v.is_empty());
    let api_key = get(store::SETTING_CRASH_AI_API_KEY).filter(|v| !v.is_empty());
    let (Some(endpoint), Some(api_key)) = (endpoint, api_key) else {
        return Ok(None);
    };
    Ok(Some(Config {
        endpoint: endpoint.trim_end_matches('/').to_string(),
        model: get(store::SETTING_CRASH_AI_MODEL)
            .filter(|v| !v.is_empty())
            .unwrap_or_else(|| "gpt-4o-mini".to_string()),
        api_key,
    }))
}

/// Запрос к провайдеру и разбор вердикта.
async fn analyze_one(http: &Client, config: &Config, crash: &PendingCrash) -> Result<Verdict, String> {
    let prompt = build_prompt(crash);
    let url = format!("{}/chat/completions", config.endpoint);
    let body = serde_json::json!({
        "model": config.model,
        "temperature": 0.2,
        "messages": [
            {
                "role": "system",
                "content": SYSTEM_PROMPT,
            },
            {
                "role": "user",
                "content": prompt,
            },
        ],
        // Вердикт нужен машиночитаемым — просим JSON-объект провайдера.
        "response_format": { "type": "json_object" },
    });

    let response = http
        .post(&url)
        .timeout(REQUEST_TIMEOUT)
        .bearer_auth(&config.api_key)
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("запрос к AI-провайдеру: {e}"))?;

    let status = response.status();
    if !status.is_success() {
        // Тело ошибки провайдера может содержать полезный диагноз
        // (неверный ключ, лимиты) — но не логируем его целиком: там
        // иногда дублируется ключ.
        let text = response.text().await.unwrap_or_default();
        let head: String = text.chars().take(300).collect();
        return Err(format!("AI-провайдер ответил {status}: {head}"));
    }

    #[derive(Deserialize)]
    struct Completion {
        choices: Vec<Choice>,
    }
    #[derive(Deserialize)]
    struct Choice {
        message: Message,
    }
    #[derive(Deserialize)]
    struct Message {
        content: String,
    }

    let completion: Completion = response
        .json()
        .await
        .map_err(|e| format!("разбор ответа AI-провайдера: {e}"))?;
    let content = completion
        .choices
        .into_iter()
        .next()
        .map(|c| c.message.content)
        .ok_or_else(|| "AI-провайдер вернул пустой ответ".to_string())?;

    parse_verdict(&content, &config.model)
}

/// Разбирает JSON-ответ модели в `Verdict`. Провайдеры иногда оборачивают
/// JSON в markdown-ограждение — снимаем его перед парсингом.
fn parse_verdict(content: &str, model: &str) -> Result<Verdict, String> {
    let trimmed = content.trim();
    let json = trimmed
        .strip_prefix("```json")
        .or_else(|| trimmed.strip_prefix("```"))
        .map(|s| s.strip_suffix("```").unwrap_or(s).trim())
        .unwrap_or(trimmed);

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct RawVerdict {
        #[serde(default)]
        summary: String,
        #[serde(default)]
        cause: String,
        #[serde(default)]
        suggestion: String,
        #[serde(default)]
        severity: String,
    }

    let raw: RawVerdict =
        serde_json::from_str(json).map_err(|e| format!("ответ модели — не JSON-вердикт: {e}"))?;
    if raw.summary.trim().is_empty() && raw.cause.trim().is_empty() {
        return Err("вердикт модели пуст".to_string());
    }
    let severity = match raw.severity.trim().to_ascii_lowercase().as_str() {
        "low" | "medium" | "high" | "critical" => raw.severity.trim().to_ascii_lowercase(),
        _ => "medium".to_string(),
    };
    Ok(Verdict {
        summary: raw.summary.trim().to_string(),
        cause: raw.cause.trim().to_string(),
        suggestion: raw.suggestion.trim().to_string(),
        severity,
        model: model.to_string(),
        analyzed_at: now_rfc3339(),
    })
}

const SYSTEM_PROMPT: &str = "Ты — диагност крашей Minecraft (NeoForge/Fabric, моды 1.21.x). \
Проанализируй crash-report и логи игрока или сервера. Ответь СТРОГО JSON-объектом \
без markdown: {\"summary\": \"1-2 предложения что случилось\", \"cause\": \"вероятная причина: \
конкретный мод/класс/драйвер/память/конфиг\", \"suggestion\": \"конкретные шаги что сделать\", \
\"severity\": \"low|medium|high|critical\"}. Отвечай на русском. \
severity: critical — сервер не запускается/падает постоянно; high — игра не запускается у игрока; \
medium — разовый краш, игра работает; low — краш без влияния (например, при выходе). \
Если данных недостаточно для точного диагноза, честно скажи об этом в cause.";

/// Склеивает краш в один промпт: метаданные + файлы логов (усечённые).
fn build_prompt(crash: &PendingCrash) -> String {
    let kind = match crash.event_type.as_str() {
        "server_crash" => "Dedicated-сервер",
        _ => "Клиент игрока",
    };
    let mut out = format!(
        "Тип: краш ({kind})\nЖурнал #{}\n",
        crash.id
    );
    if let Some(username) = &crash.username {
        out.push_str(&format!("Игрок: {username}\n"));
    }
    out.push_str(&format!("Сводка: {}\n\n", crash.summary));

    // Ключи details соответствуют полям ReportCrashRequest/ReportServerCrashRequest.
    let files: &[(&str, &str)] = &[
        ("modReport", "Отчёт мода Stardust"),
        ("crashReport", "crash-report.txt"),
        ("stackTrace", "stack trace"),
        ("latestLog", "latest.log"),
        ("debugLog", "debug.log"),
        ("launcherLog", "launcher.log"),
    ];
    for (key, title) in files {
        if let Some(text) = crash.details.get(*key).and_then(|v| v.as_str()) {
            if !text.trim().is_empty() {
                out.push_str(&format!("===== {title} =====\n{}\n\n", truncate_log(text)));
            }
        }
    }
    // Серверный краш: errorClass/message дублируют стек, но если стека нет —
    // пригодятся.
    for key in ["server", "thread", "errorClass", "message"] {
        if let Some(text) = crash.details.get(key).and_then(|v| v.as_str()) {
            if !text.trim().is_empty() {
                out.push_str(&format!("{key}: {text}\n"));
            }
        }
    }
    out
}

/// Усекает лог до `MAX_LOG_CHARS`, сохраняя голову и хвост: начало — это
/// запуск и конфиг, конец — последние строки перед падением.
fn truncate_log(text: &str) -> String {
    if text.chars().count() <= MAX_LOG_CHARS {
        return text.to_string();
    }
    let head_chars = MAX_LOG_CHARS * 2 / 5;
    let tail_chars = MAX_LOG_CHARS - head_chars;
    let head: String = text.chars().take(head_chars).collect();
    let tail: String = text
        .chars()
        .skip(text.chars().count() - tail_chars)
        .collect();
    format!("{head}\n… [усечено] …\n{tail}")
}

/// Короткое уведомление админам в Telegram с вердиктом.
async fn notify_admins(state: &crate::Shared, crash: &PendingCrash, verdict: &Verdict) {
    let who = crash
        .username
        .as_deref()
        .map(|u| format!("игрока «{u}»"))
        .unwrap_or_else(|| "dedicated-сервера".to_string());
    let severity = match verdict.severity.as_str() {
        "critical" => "🔴 critical",
        "high" => "🟠 high",
        "low" => "🟢 low",
        _ => "🟡 medium",
    };
    let text = format!(
        "🤖 AI-разбор краша {who} (журнал #{})\n{severity}\n\n{}\n\nПричина: {}\nРешение: {}",
        crash.id, verdict.summary, verdict.cause, verdict.suggestion
    );
    if let Err(e) = state.store.notify_admins(&text).await {
        tracing::warn!("[crash-ai] уведомление админов: {e}");
    }
}

fn now_rfc3339() -> String {
    OffsetDateTime::now_utc()
        .format(&Rfc3339)
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_verdict_accepts_plain_json() {
        let content = r#"{"summary":"Краш при запуске","cause":"Мод X","suggestion":"Удалить мод","severity":"high"}"#;
        let verdict = parse_verdict(content, "test-model").expect("verdict");
        assert_eq!(verdict.summary, "Краш при запуске");
        assert_eq!(verdict.severity, "high");
        assert_eq!(verdict.model, "test-model");
        assert!(!verdict.analyzed_at.is_empty());
    }

    #[test]
    fn parse_verdict_strips_markdown_fence() {
        let content = "```json\n{\"summary\":\"s\",\"cause\":\"c\",\"suggestion\":\"x\",\"severity\":\"low\"}\n```";
        let verdict = parse_verdict(content, "m").expect("verdict");
        assert_eq!(verdict.severity, "low");
    }

    #[test]
    fn parse_verdict_normalizes_unknown_severity() {
        let content = r#"{"summary":"s","cause":"c","suggestion":"x","severity":"ОЧЕНЬ ПЛОХО"}"#;
        let verdict = parse_verdict(content, "m").expect("verdict");
        assert_eq!(verdict.severity, "medium");
    }

    #[test]
    fn parse_verdict_rejects_empty_and_garbage() {
        assert!(parse_verdict(r#"{"summary":"","cause":"","suggestion":"","severity":""}"#, "m").is_err());
        assert!(parse_verdict("извините, я не могу", "m").is_err());
    }

    #[test]
    fn truncate_log_keeps_head_and_tail() {
        let text = "A".repeat(100) + &"B".repeat(40_000) + &"C".repeat(100);
        let truncated = truncate_log(&text);
        assert!(truncated.chars().count() < text.chars().count());
        assert!(truncated.starts_with("AAAA"));
        assert!(truncated.ends_with("CCCC"));
        assert!(truncated.contains("усечено"));
    }

    #[test]
    fn truncate_log_short_passthrough() {
        assert_eq!(truncate_log("короткий лог"), "короткий лог");
    }

    #[test]
    fn build_prompt_includes_files_and_metadata() {
        let crash = PendingCrash {
            id: 42,
            event_type: "client_crash".to_string(),
            username: Some("Steve".to_string()),
            summary: "Код выхода: 1".to_string(),
            details: serde_json::json!({
                "exitCode": 1,
                "crashReport": "java.lang.NullPointerException at mod.Foo",
                "latestLog": "[INFO] loading",
                "debugLog": null,
            }),
        };
        let prompt = build_prompt(&crash);
        assert!(prompt.contains("Журнал #42"));
        assert!(prompt.contains("Steve"));
        assert!(prompt.contains("crash-report.txt"));
        assert!(prompt.contains("NullPointerException"));
        assert!(prompt.contains("[INFO] loading"));
        // Отсутствующий файл не попадает в промпт.
        assert!(!prompt.contains("debug.log"));
    }
}
