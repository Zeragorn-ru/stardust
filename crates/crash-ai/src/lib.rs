//! Общая логика AI-разбора крашей Minecraft.
//!
//! Крейт не зависит ни от БД, ни от конкретного сервера: на вход получает
//! нейтральный [`CrashInput`], на выход отдаёт [`Verdict`]. Хранение,
//! очереди, настройки и уведомления — на стороне потребителей (auth-server
//! и admin-server), чтобы логика провайдера и промпт не дублировались.
//!
//! Провайдер — любой OpenAI-совместимый chat-completions endpoint
//! (OpenAI, OpenRouter, локальные vLLM/Ollama и т.п.).

use std::time::Duration;

use reqwest::Client;
use serde::{Deserialize, Serialize};
use time::format_description::well_known::Rfc3339;
use time::OffsetDateTime;

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

/// Нейтральный вход разбора: что за краш и его сырые данные.
///
/// `event_type` — `client_crash` или `server_crash`; `details` — JSONB
/// журнала (логи, стек, моды) в том виде, в каком его записал auth-server.
#[derive(Clone, Debug)]
pub struct CrashInput {
    pub id: i64,
    pub event_type: String,
    pub username: Option<String>,
    pub summary: String,
    pub details: serde_json::Value,
}

/// Вердикт анализа — хранится в `server_logs.ai_analysis`.
#[derive(Debug, Clone, Serialize, Deserialize)]
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
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Failure {
    pub error: String,
    pub analyzed_at: String,
}

impl Failure {
    pub fn new(error: impl Into<String>) -> Self {
        Self {
            error: error.into(),
            analyzed_at: now_rfc3339(),
        }
    }
}

/// Таймаут одного запроса к провайдеру: краш-репорты большие, ответ
/// генерируется долго, но вечно ждать нельзя (воркер последовательный).
const REQUEST_TIMEOUT: Duration = Duration::from_secs(120);

/// Максимум символов одного лога, отправляемых модели. Полные debug.log
/// бывают на мегабайты — режем, оставляя голову (запуск и конфигурация)
/// и хвост (последние строки перед падением — самые диагностические).
const MAX_LOG_CHARS: usize = 24_000;

/// Читает конфигурацию провайдера из settings. `None` — анализ выключен или
/// настроен не полностью (нет endpoint/ключа); это нормальное состояние,
/// потребитель просто ничего не делает. Общая для обоих серверов.
pub async fn load_config(db: &store::Store) -> Result<Option<Config>, String> {
    let keys = [
        store::SETTING_CRASH_AI_ENABLED,
        store::SETTING_CRASH_AI_ENDPOINT,
        store::SETTING_CRASH_AI_MODEL,
        store::SETTING_CRASH_AI_API_KEY,
    ];
    let map = db
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

/// Прогоняет один краш через провайдера и разбирает вердикт.
pub async fn analyze(
    http: &Client,
    config: &Config,
    crash: &CrashInput,
) -> Result<Verdict, String> {
    let prompt = build_prompt(crash);
    let url = format!("{}/chat/completions", config.endpoint);
    let body = serde_json::json!({
        "model": config.model,
        "temperature": 0.2,
        "messages": [
            { "role": "system", "content": SYSTEM_PROMPT },
            { "role": "user", "content": prompt },
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
        // Тело ошибки провайдера может содержать диагноз (неверный ключ,
        // лимиты) — но не логируем целиком: иногда там дублируется ключ.
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

/// Разбирает JSON-ответ модели в [`Verdict`]. Провайдеры иногда оборачивают
/// JSON в markdown-ограждение — снимаем его перед парсингом.
pub fn parse_verdict(content: &str, model: &str) -> Result<Verdict, String> {
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
        s @ ("low" | "medium" | "high" | "critical") => s.to_string(),
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

const SYSTEM_PROMPT: &str = "Ты — диагност крашей Minecraft (загрузчики NeoForge/Fabric, версии 1.21.x и 26.x). \
Твоя задача — по crash-report, логам и окружению назвать конкретную причину и дать игроку \
понятные шаги решения. \
\
Методика: (1) сначала найди корневое исключение — секцию «Description:» crash-отчёта, \
последний «Caused by:» в стеке, FATAL/ERROR-строки в логах; (2) определи виновника по стеку: \
пакет мода (не net.minecraft / не загрузчик) — виноват мод, сверь его имя и версию со списком \
в «Окружении»; (3) учитывай контекст: версия Minecraft/загрузчика/Java, ОС и архитектура, \
выделенная память против доступной, конфликтующие моды. \
\
Частые классы причин: OutOfMemoryError / маленький -Xmx; Exit Code 1 при старте — ошибка \
конфигурации или мода; Exit Code -1073741819 (0xC0000005) / -1073740791 (0xC0000409) / -6 \
(SIGABRT) — нативный краш (драйвер GPU, античит, повреждённая JVM); hs_err_pid-лог — нативный \
краш JVM: смотри siginfo, проблемную библиотеку в секциях stack/dynamic libraries; \
«Mod loading errors» — несовместимость мода с версией игры/загрузчика; \
Rendering / OpenGL / GLFW ошибки — драйвер видеокарты или несовместимый шейдер-пак; \
PixelFormat / LWJGL — проблема видеодрайвера; watchdog/timeout на сервере — зависание тика. \
Для Minecraft 26.x: игра не обфусцирована, имена классов в стеке «человеческие»; Fabric-моды \
26.x собраны под Java 25. \
\
Качество ответа: summary — 1-2 предложения простыми словами, что случилось (игрок не \
программист); cause — конкретика: имя мода/класса/драйвера, код выхода, нехватка чего — без \
воды и без «вероятно, проблема в моде» когда в стеке есть точное имя; suggestion — пошаговые \
действия игрока (что обновить/удалить/увеличить/переустановить), самое важное первым шагом. \
Не выдумывай моды, которых нет в списке «Окружения». Если данных недостаточно для точного \
диагноза — честно скажи об этом в cause и предложи в suggestion собрать недостающее. \
\
Ответь СТРОГО одним JSON-объектом без markdown-ограждений и без текста вокруг: \
{\"summary\": \"...\", \"cause\": \"...\", \"suggestion\": \"...\", \"severity\": \"low|medium|high|critical\"}. \
Отвечай на русском. \
severity: critical — сервер не запускается или падает постоянно; high — игра не запускается \
у игрока или крашится каждый раз в одном месте; medium — разовый краш, игра в целом работает; \
low — краш без влияния на процесс (например, при выходе из игры).";

/// Склеивает краш в один промпт: метаданные + окружение + файлы логов (усечённые).
pub fn build_prompt(crash: &CrashInput) -> String {
    let kind = match crash.event_type.as_str() {
        "server_crash" => "Dedicated-сервер",
        _ => "Клиент игрока",
    };
    let mut out = format!("Тип: краш ({kind})\nЖурнал #{}\n", crash.id);
    if let Some(username) = &crash.username {
        out.push_str(&format!("Игрок: {username}\n"));
    }
    out.push_str(&format!("Сводка: {}\n\n", crash.summary));

    // Окружение клиента: ОС/арх, версии лаунчера/MC/загрузчика/Java, память.
    // Даёт модели стек для точного диагноза (несовместимость, нехватка RAM,
    // нативные библиотеки под конкретную ОС).
    if let Some(env) = crash
        .details
        .get("environment")
        .and_then(|v| v.as_object())
        .filter(|env| !env.is_empty())
    {
        out.push_str("===== Окружение =====\n");
        for (key, value) in env {
            if let Some(text) = value.as_str().filter(|s| !s.is_empty()) {
                out.push_str(&format!("{key}: {text}\n"));
            } else if value.is_number() || value.is_boolean() {
                out.push_str(&format!("{key}: {value}\n"));
            }
        }
        out.push('\n');
    }

    // Список модов на момент краша: имя мода часто и есть причина.
    if let Some(mods) = crash.details.get("mods").and_then(|v| v.as_array()) {
        let names: Vec<&str> = mods.iter().filter_map(|m| m.as_str()).collect();
        if !names.is_empty() {
            out.push_str(&format!("===== Моды ({}) =====\n{}\n\n", names.len(), names.join("\n")));
        }
    }

    // Ключи details соответствуют полям ReportCrashRequest/ReportServerCrashRequest.
    let files: &[(&str, &str)] = &[
        ("modReport", "Отчёт мода Stardust"),
        ("crashReport", "crash-report.txt"),
        ("jvmLog", "JVM-лог нативного краша (hs_err_pid)"),
        ("stackTrace", "stack trace"),
        ("latestLog", "latest.log"),
        ("debugLog", "debug.log"),
        ("launcherLog", "launcher.log"),
    ];
    for (key, title) in files {
        if let Some(text) = crash.details.get(*key).and_then(|v| v.as_str()) {
            if !text.trim().is_empty() {
                out.push_str(&format!(
                    "===== {title} =====\n{}\n\n",
                    truncate_log(text)
                ));
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

/// Усекает лог до `MAX_LOG_CHARS`, сохраняя голову и хвост: начало — запуск
/// и конфиг, конец — последние строки перед падением.
fn truncate_log(text: &str) -> String {
    let total = text.chars().count();
    if total <= MAX_LOG_CHARS {
        return text.to_string();
    }
    let head_chars = MAX_LOG_CHARS * 2 / 5;
    let tail_chars = MAX_LOG_CHARS - head_chars;
    let head: String = text.chars().take(head_chars).collect();
    let tail: String = text.chars().skip(total - tail_chars).collect();
    format!("{head}\n… [усечено] …\n{tail}")
}

fn now_rfc3339() -> String {
    OffsetDateTime::now_utc()
        .format(&Rfc3339)
        .unwrap_or_default()
}

/// Короткое Telegram-уведомление админам с вердиктом. Общая для обоих
/// серверов (auth-server разбирает сразу для игрока, admin-server — фоново),
/// чтобы текст не разъезжался.
pub fn admin_notification(id: i64, username: Option<&str>, verdict: &Verdict) -> String {
    let who = username
        .map(|u| format!("игрока «{u}»"))
        .unwrap_or_else(|| "dedicated-сервера".to_string());
    let severity = match verdict.severity.as_str() {
        "critical" => "🔴 critical",
        "high" => "🟠 high",
        "low" => "🟢 low",
        _ => "🟡 medium",
    };
    format!(
        "🤖 AI-разбор краша {who} (журнал #{id})\n{severity}\n\n{}\n\nПричина: {}\nРешение: {}",
        verdict.summary, verdict.cause, verdict.suggestion
    )
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
        assert_eq!(parse_verdict(content, "m").expect("verdict").severity, "low");
    }

    #[test]
    fn parse_verdict_normalizes_unknown_severity() {
        let content = r#"{"summary":"s","cause":"c","suggestion":"x","severity":"ОЧЕНЬ ПЛОХО"}"#;
        assert_eq!(parse_verdict(content, "m").expect("verdict").severity, "medium");
    }

    #[test]
    fn parse_verdict_rejects_empty_and_garbage() {
        assert!(
            parse_verdict(r#"{"summary":"","cause":"","suggestion":"","severity":""}"#, "m").is_err()
        );
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
    fn admin_notification_mentions_player_and_verdict() {
        let verdict = Verdict {
            summary: "Краш при запуске".into(),
            cause: "Мод X".into(),
            suggestion: "Удалить мод".into(),
            severity: "critical".into(),
            model: "m".into(),
            analyzed_at: now_rfc3339(),
        };
        let text = admin_notification(7, Some("Steve"), &verdict);
        assert!(text.contains("Steve"));
        assert!(text.contains("#7"));
        assert!(text.contains("critical"));
        assert!(text.contains("Удалить мод"));
        let server_text = admin_notification(8, None, &verdict);
        assert!(server_text.contains("dedicated-сервера"));
    }

    #[test]
    fn build_prompt_includes_files_and_metadata() {
        let crash = CrashInput {
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

    #[test]
    fn build_prompt_includes_environment_mods_and_jvm_log() {
        let crash = CrashInput {
            id: 7,
            event_type: "client_crash".to_string(),
            username: None,
            summary: "Код выхода: -1".to_string(),
            details: serde_json::json!({
                "environment": {
                    "os": "macOS 15.2 (aarch64)",
                    "launcherVersion": "0.11.21",
                    "minecraft": "26.2",
                    "loader": "Fabric 0.19.5",
                    "java": "Temurin 21.0.5",
                    "memoryAllocatedMb": 4096,
                    "memoryTotalMb": 16384
                },
                "mods": ["Volcanic-1.21.1-0.1.3-alpha.jar", "sodium.jar"],
                "jvmLog": "# SIGSEGV (0xb) at pc=0x...",
            }),
        };
        let prompt = build_prompt(&crash);
        assert!(prompt.contains("Окружение"));
        assert!(prompt.contains("macOS 15.2 (aarch64)"));
        assert!(prompt.contains("memoryAllocatedMb: 4096"));
        assert!(prompt.contains("Моды (2)"));
        assert!(prompt.contains("Volcanic-1.21.1-0.1.3-alpha.jar"));
        assert!(prompt.contains("JVM-лог нативного краша"));
        assert!(prompt.contains("SIGSEGV"));
    }

    #[test]
    fn build_prompt_skips_empty_environment_and_mods() {
        let crash = CrashInput {
            id: 8,
            event_type: "client_crash".to_string(),
            username: None,
            summary: "s".to_string(),
            details: serde_json::json!({ "environment": {}, "mods": [] }),
        };
        let prompt = build_prompt(&crash);
        assert!(!prompt.contains("Окружение"));
        assert!(!prompt.contains("Моды"));
    }
}
