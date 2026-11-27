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
#[derive(Clone, Debug, Default)]
pub struct CrashInput {
    pub id: i64,
    pub event_type: String,
    pub username: Option<String>,
    pub summary: String,
    pub details: serde_json::Value,
    // Заготовки на будущее: пока callers не заполняют (поля опциональные).
    // Версия лаунчера и SHA манифеста позволят сверить сборку игрока с эталоном.
    pub launcher_version: Option<String>,
    pub modpack_manifest_sha: Option<String>,
    /// Optional-выборы игрока (включённые/выключенные моды) — возможный
    /// источник несовместимостей внутри управляемой сборки.
    pub player_choices: Option<Vec<String>>,
}

/// Вердикт анализа — хранится в `server_logs.ai_analysis`.
///
/// Тексты заведомо короткие (см. [`MAX_SUMMARY_CHARS`] и т.п.) и написаны
/// для обычного игрока: без стеков, кодов ошибок и английского жаргона.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Verdict {
    /// Одно короткое предложение — что случилось.
    pub summary: String,
    /// Причина простыми словами, без технических подробностей.
    pub cause: String,
    /// 1–3 действия игрока, каждое с новой строки (`\n`), без маркеров.
    pub suggestion: String,
    /// `low` / `medium` / `high` / `critical`.
    pub severity: String,
    /// Модель, давшая вердикт.
    pub model: String,
    /// Когда проанализировано (RFC 3339).
    pub analyzed_at: String,
    /// Влияние optional-выборов игрока на краш: короткая фраза или «нет».
    /// `None` — старые вердикты до появления поля (не ломаем хранилище/UI).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub player_choice_impact: Option<String>,
}

impl Verdict {
    /// Действия из `suggestion` по строкам. Пустые строки отбрасываются —
    /// потребителям (Telegram, UI) не нужно самим разбирать маркеры.
    pub fn actions(&self) -> Vec<&str> {
        self.suggestion
            .lines()
            .map(str::trim)
            .filter(|line| !line.is_empty())
            .collect()
    }
}

/// Жёсткие лимиты длины вердикта. Промпт просит короче — эти значения
/// страхуют от модели, которая просьбу проигнорировала, и не дают UI
/// превратиться в простыню. Действия — не длиннее строки и не больше
/// [`MAX_ACTIONS`] штук.
pub const MAX_SUMMARY_CHARS: usize = 180;
pub const MAX_CAUSE_CHARS: usize = 140;
pub const MAX_ACTION_CHARS: usize = 120;
pub const MAX_ACTIONS: usize = 3;

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
        // Модель старого промпта может не вернуть поле — не считаем ошибкой.
        #[serde(default)]
        player_choice_impact: Option<String>,
    }

    let raw: RawVerdict =
        serde_json::from_str(json).map_err(|e| format!("ответ модели — не JSON-вердикт: {e}"))?;
    let summary = one_line(&raw.summary);
    let cause = one_line(&raw.cause);
    if summary.is_empty() && cause.is_empty() {
        return Err("вердикт модели пуст".to_string());
    }
    let severity = match raw.severity.trim().to_ascii_lowercase().as_str() {
        s @ ("low" | "medium" | "high" | "critical") => s.to_string(),
        _ => "medium".to_string(),
    };
    Ok(Verdict {
        // Модель может проигнорировать лимиты из промпта — обрезаем здесь,
        // чтобы хранилище и UI не зависели от её дисциплины.
        summary: truncate_words(&summary, MAX_SUMMARY_CHARS),
        cause: truncate_words(&cause, MAX_CAUSE_CHARS),
        suggestion: normalize_actions(&raw.suggestion),
        severity,
        model: model.to_string(),
        analyzed_at: now_rfc3339(),
        // Ограничиваем длину так же, как cause: поле идёт в уведомление.
        player_choice_impact: raw
            .player_choice_impact
            .map(|v| truncate_words(&one_line(&v), MAX_CAUSE_CHARS))
            .filter(|v| !v.is_empty() && v != "нет"),
    })
}

/// Схлопывает переводы строк и повторные пробелы: summary и cause — одна
/// строка, без переноса из ответа модели.
fn one_line(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Обрезает текст до `limit` символов по границе слова и добавляет «…».
fn truncate_words(text: &str, limit: usize) -> String {
    if text.chars().count() <= limit {
        return text.to_string();
    }
    let mut cut: String = text.chars().take(limit).collect();
    // Если лимит пришёлся ровно на границу слова (следующий символ — пробел),
    // ничего не теряем. Иначе отступаем к последнему пробелу, чтобы не рвать
    // слово, но не ниже половины лимита — иначе обрезка станет слишком короткой.
    let next_is_space = text.chars().nth(limit).is_none_or(char::is_whitespace);
    if !next_is_space {
        // `rfind` возвращает байтовый индекс, а лимит — в символах: порог
        // сравниваем в символах, иначе кириллица (2 байта на букву) обрезалась
        // бы почти вдвое раньше.
        if let Some(pos) = cut
            .char_indices()
            .rev()
            .find(|(_, c)| c.is_whitespace())
            .map(|(pos, _)| pos)
            .filter(|pos| cut[..*pos].chars().count() > limit / 2)
        {
            cut.truncate(pos);
        }
    }
    format!("{}…", cut.trim_end())
}

/// Снимает с действия маркер списка («- », «• », «1. », «1) »).
fn strip_bullet(line: &str) -> String {
    let trimmed = line.trim();
    if let Some(rest) = trimmed
        .strip_prefix("- ")
        .or_else(|| trimmed.strip_prefix("* "))
        .or_else(|| trimmed.strip_prefix("• "))
        .or_else(|| trimmed.strip_prefix("– "))
    {
        return rest.trim().to_string();
    }
    let digits = trimmed.chars().take_while(char::is_ascii_digit).count();
    if digits > 0 {
        let rest = &trimmed[digits..];
        if let Some(rest) = rest.strip_prefix(". ").or_else(|| rest.strip_prefix(") ")) {
            return rest.trim().to_string();
        }
    }
    trimmed.to_string()
}

/// Приводит `suggestion` к списку действий: по действию на строку, без
/// маркеров, не больше [`MAX_ACTIONS`] штук и [`MAX_ACTION_CHARS`] символов
/// каждое. Одна длинная строка через «; » тоже режется на действия.
fn normalize_actions(text: &str) -> String {
    let mut actions: Vec<String> = text
        .lines()
        .map(strip_bullet)
        .filter(|line| !line.is_empty())
        .collect();
    if actions.len() == 1 && actions[0].chars().count() > MAX_ACTION_CHARS {
        let split: Vec<String> = actions[0]
            .split("; ")
            .map(strip_bullet)
            .filter(|part| !part.is_empty())
            .collect();
        if split.len() > 1 {
            actions = split;
        }
    }
    actions
        .into_iter()
        .take(MAX_ACTIONS)
        .map(|action| truncate_words(&action, MAX_ACTION_CHARS))
        .collect::<Vec<_>>()
        .join("\n")
}

const SYSTEM_PROMPT: &str = "Ты — диагност крашей Minecraft (загрузчики NeoForge/Fabric, версии 1.21.x и 26.x). \
Ответ читает обычный игрок, а не программист: пиши по-русски, коротко и без технического жаргона. \
\
Контекст платформы (считай его достоверным без проверки): у всех игроков кастомный лаунчер StarDust, \
сборка модов управляется лаунчером — манифест по SHA-1, профили модов взаимоисключающие, один всегда выбран. \
Игрок НЕ может добавлять сторонние моды в сборку или менять версии — только включать/выключать optional-моды \
среди предложенных (выключенные лежат файлами с суффиксом .dis и не грузятся). Версии Java, Minecraft, \
загрузчика и модов приходят из манифеста лаунчера, а не ставятся игроком вручную. \
Отсюда порядок подозреваемых: 1) баг самой сборки/манифеста (не те версии, конфликт внутри сборки); \
2) несовместимость optional-выборов игрока — их комбинация может ломать игру; 3) проблемы среды \
(Java из манифеста, память, драйверы, ОС). Версию «игрок сам наставил модов» НЕ рассматривай — это невозможно. \
\
Методика (внутренняя, в ответ её не переноси): найди корневое исключение — «Description:» \
crash-отчёта, последний «Caused by:», FATAL/ERROR в логах; определи виновника по стеку мода \
(пакет вне net.minecraft и загрузчика) и сверь с «Окружением»; учти версии Java/Minecraft/загрузчика, \
ОС, выделенную и доступную память. Частые причины: мало памяти; ошибка в моде или конфликт модов; \
старый или неподходящий драйвер видеокарты; повреждённая Java; нет интернета. \
Не выдумывай моды, которых нет в списке «Окружения». Если данных не хватает — так и скажи и предложи, \
что приложить к отчёту. \
\
Поля (все на русском): \
summary — ОДНО короткое предложение (до 160 символов): что случилось, без кодов ошибок, имён классов \
и стеков. Пример: «Игра не запустилась: не хватило памяти для сборки». \
cause — одна фраза (до 120 символов), причина простыми словами. Называй мод его обычным именем \
(«мод Create»), а не пакетом. Упоминай конкретное (имя мода, «мало памяти», «старая Java»), \
но без кодов выхода, исключений и путей к файлам. \
suggestion — от 1 до 3 действий, каждое с новой строки, без нумерации и маркеров, до 100 символов. \
Каждое действие — конкретное и выполнимое в лаунчере: «Поставь Java 21.0.13.1 в Настройках → Java», \
«Выключи мод X в разделе Сборка», «Проверь подключение к интернету», «Выдели больше памяти в \
Настройках». Самое важное — первой строкой. Не пересказывай логи и не давай общих советов \
(«переустанови игру») без причины. \
severity — low / medium / high / critical. \
playerChoiceImpact — одна короткая фраза (до 100 символов): влияют ли optional-выборы игрока на краш. \
Если да — назови мод(ы) и как; если нет или выборы неизвестны — «нет». \
\
Ответь СТРОГО одним JSON-объектом без markdown и без текста вокруг: \
{\"summary\": \"...\", \"cause\": \"...\", \"suggestion\": \"строка 1\\nстрока 2\", \"severity\": \"low|medium|high|critical\", \"playerChoiceImpact\": \"...\"}. \
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
    // Заготовки на будущее: когда callers начнут заполнять, модель увидит
    // версию лаунчера, манифест и выборы игрока даже без details.
    if let Some(version) = &crash.launcher_version {
        out.push_str(&format!("Версия лаунчера: {version}\n"));
    }
    if let Some(sha) = &crash.modpack_manifest_sha {
        out.push_str(&format!("SHA манифеста сборки: {sha}\n"));
    }
    if let Some(choices) = &crash.player_choices {
        if !choices.is_empty() {
            out.push_str(&format!(
                "Optional-выборы игрока: {}\n",
                choices.join(", ")
            ));
        }
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
            out.push_str(&format!(
                "===== Моды ({}) =====\n{}\n\n",
                names.len(),
                names.join("\n")
            ));
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
        "critical" => "🔴 критично",
        "high" => "🟠 серьёзно",
        "low" => "🟢 мелочь",
        _ => "🟡 средне",
    };
    // Действия уже по строке на шаг (см. `normalize_actions`) — нумеруем, чтобы
    // в Telegram список читался как шаги, а не как слипшаяся строка.
    let actions = verdict
        .actions()
        .iter()
        .enumerate()
        .map(|(i, action)| format!("{}. {action}", i + 1))
        .collect::<Vec<_>>()
        .join("\n");
    let mut text = format!(
        "🤖 AI-разбор краша {who} (журнал #{id})\n{severity}\n\n{}\n\nПричина: {}",
        verdict.summary, verdict.cause
    );
    if !actions.is_empty() {
        text.push_str(&format!("\n\nЧто сделать:\n{actions}"));
    }
    // Поле появилось позже остальных — печатаем только когда модель его дала.
    if let Some(impact) = &verdict.player_choice_impact {
        text.push_str(&format!("\n\nВлияние выборов игрока: {impact}"));
    }
    text
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
        assert_eq!(
            parse_verdict(content, "m").expect("verdict").severity,
            "low"
        );
    }

    #[test]
    fn parse_verdict_normalizes_unknown_severity() {
        let content = r#"{"summary":"s","cause":"c","suggestion":"x","severity":"ОЧЕНЬ ПЛОХО"}"#;
        assert_eq!(
            parse_verdict(content, "m").expect("verdict").severity,
            "medium"
        );
    }

    #[test]
    fn parse_verdict_rejects_empty_and_garbage() {
        assert!(parse_verdict(
            r#"{"summary":"","cause":"","suggestion":"","severity":""}"#,
            "m"
        )
        .is_err());
        assert!(parse_verdict("извините, я не могу", "m").is_err());
    }

    #[test]
    fn parse_verdict_collapses_multiline_summary_and_cause() {
        let content = r#"{"summary":"Игра\nне  запустилась","cause":"Мало\tпамяти","suggestion":"s","severity":"high"}"#;
        let verdict = parse_verdict(content, "m").expect("verdict");
        assert_eq!(verdict.summary, "Игра не запустилась");
        assert_eq!(verdict.cause, "Мало памяти");
    }

    #[test]
    fn parse_verdict_truncates_long_fields_by_word() {
        let long_summary = "слово ".repeat(200);
        let long_cause = "причина ".repeat(100);
        let content = format!(
            r#"{{"summary":"{long_summary}","cause":"{long_cause}","suggestion":"s","severity":"low"}}"#
        );
        let verdict = parse_verdict(&content, "m").expect("verdict");
        assert!(verdict.summary.chars().count() <= MAX_SUMMARY_CHARS + 1);
        assert!(verdict.summary.ends_with('…'));
        assert!(!verdict.summary.ends_with(' '));
        // Слово не разрезано: хвост перед многоточием — целое «слово».
        assert!(verdict.summary.trim_end_matches('…').ends_with("слово"));
        assert!(verdict.cause.chars().count() <= MAX_CAUSE_CHARS + 1);
    }

    #[test]
    fn parse_verdict_strips_action_bullets_and_limits_count() {
        let content = r#"{"summary":"s","cause":"c","suggestion":"- Поставь Java 21\n2) Выключи мод X\n• Проверь интернет\nчетвёртое действие","severity":"high"}"#;
        let verdict = parse_verdict(content, "m").expect("verdict");
        assert_eq!(
            verdict.actions(),
            vec!["Поставь Java 21", "Выключи мод X", "Проверь интернет"]
        );
        assert_eq!(verdict.suggestion.lines().count(), MAX_ACTIONS);
    }

    #[test]
    fn parse_verdict_splits_single_long_suggestion() {
        let content = serde_json::json!({
            "summary": "s",
            "cause": "c",
            "suggestion": "Поставь Java 21 в Настройках и перезапусти лаунчер, затем попробуй снова; \
                           выключи мод X в разделе Сборка и запусти игру; \
                           проверь подключение к интернету и перезапусти лаунчер",
            "severity": "medium",
        })
        .to_string();
        let verdict = parse_verdict(&content, "m").expect("verdict");
        assert_eq!(verdict.actions().len(), 3);
        assert!(verdict.actions()[1].starts_with("выключи мод X"));
    }

    #[test]
    fn parse_verdict_truncates_long_action() {
        let action = "действие ".repeat(50);
        let content = serde_json::json!({
            "summary": "s",
            "cause": "c",
            "suggestion": action,
            "severity": "low",
        })
        .to_string();
        let verdict = parse_verdict(&content, "m").expect("verdict");
        assert!(verdict.suggestion.chars().count() <= MAX_ACTION_CHARS + 1);
        assert!(verdict.suggestion.ends_with('…'));
    }

    #[test]
    fn truncate_words_respects_limit_and_short_text() {
        assert_eq!(truncate_words("коротко", 10), "коротко");
        let text = "один два три четыре пять";
        let cut = truncate_words(text, 12);
        assert_eq!(cut, "один два три…");
    }

    #[test]
    fn truncate_words_counts_cyrillic_chars_not_bytes() {
        // 2 байта на букву: байтовый порог отрезал бы уже одно слово.
        let text = "поставь джаву и перезапусти лаунчер";
        let cut = truncate_words(text, 16);
        assert_eq!(cut, "поставь джаву и…");
    }

    #[test]
    fn parse_verdict_reads_player_choice_impact() {
        let content = r#"{"summary":"s","cause":"c","suggestion":"x","severity":"high","playerChoiceImpact":"конфликт модов X и Y"}"#;
        let verdict = parse_verdict(content, "m").expect("verdict");
        assert_eq!(
            verdict.player_choice_impact.as_deref(),
            Some("конфликт модов X и Y")
        );
        // Старый промпт без поля — вердикт всё равно валиден.
        let legacy = parse_verdict(
            r#"{"summary":"s","cause":"c","suggestion":"x","severity":"low"}"#,
            "m",
        )
        .expect("verdict");
        assert_eq!(legacy.player_choice_impact, None);
        // «нет» и пустота схлопываются в None.
        let none = parse_verdict(
            r#"{"summary":"s","cause":"c","suggestion":"x","severity":"low","playerChoiceImpact":"нет"}"#,
            "m",
        )
        .expect("verdict");
        assert_eq!(none.player_choice_impact, None);
    }

    #[test]
    fn build_prompt_includes_player_choices_from_input() {
        let crash = CrashInput {
            id: 9,
            event_type: "client_crash".to_string(),
            username: None,
            summary: "s".to_string(),
            details: serde_json::json!({}),
            launcher_version: Some("0.11.21".to_string()),
            modpack_manifest_sha: Some("abcd1234".to_string()),
            player_choices: Some(vec!["sodium".to_string(), "iris".to_string()]),
        };
        let prompt = build_prompt(&crash);
        assert!(prompt.contains("Версия лаунчера: 0.11.21"));
        assert!(prompt.contains("abcd1234"));
        assert!(prompt.contains("sodium, iris"));
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
            player_choice_impact: Some("включён мод X".into()),
        };
        let text = admin_notification(7, Some("Steve"), &verdict);
        assert!(text.contains("Steve"));
        assert!(text.contains("#7"));
        assert!(text.contains("критично"));
        assert!(text.contains("1. Удалить мод"));
        assert!(text.contains("Что сделать"));
        assert!(text.contains("Влияние выборов игрока"));
        let server_text = admin_notification(8, None, &verdict);
        assert!(server_text.contains("dedicated-сервера"));
        // Без поля строка про выборы игрока не печатается.
        let mut old = verdict;
        old.player_choice_impact = None;
        assert!(!admin_notification(9, None, &old).contains("выборов игрока"));
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
            ..Default::default()
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
            ..Default::default()
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
            ..Default::default()
        };
        let prompt = build_prompt(&crash);
        assert!(!prompt.contains("Окружение"));
        assert!(!prompt.contains("Моды"));
    }
}
