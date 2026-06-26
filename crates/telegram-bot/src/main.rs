//! Telegram-бот платформы: 2FA-коды и админские уведомления.
//!
//! Сервис намеренно «тонкий»: вся логика и данные живут в общей БД (крейт
//! `store`). Бот делает только две вещи:
//!
//!  1. **Доставка** — забирает сообщения из `telegram_outbox` (их туда кладут
//!     auth-server и admin-server) и отправляет через Bot API `sendMessage`.
//!  2. **Привязка** — слушает `getUpdates` (long-poll) и обрабатывает команды
//!     `/start <code>` (привязать chat к аккаунту) и `/unlink` (отвязать).
//!
//! Токен бота хранится в `settings` (его задаёт админ через веб-админку), а не
//! в переменных окружения. Бот периодически перечитывает токен и подхватывает
//! смену без рестарта контейнера. Из окружения нужен только `DATABASE_URL`.

use std::sync::Arc;
use std::time::Duration;

use store::{
    ChallengeAnswer, Store, CALLBACK_APPROVE, CALLBACK_DENY, SETTING_TELEGRAM_TOKEN,
    SETTING_TELEGRAM_USERNAME,
};

/// Как часто опрашивать outbox на новые сообщения.
const OUTBOX_POLL: Duration = Duration::from_secs(2);
/// Как часто перечитывать токен из БД (подхват смены без рестарта).
const TOKEN_REFRESH: Duration = Duration::from_secs(15);
/// Таймаут long-poll `getUpdates` (секунды, серверная сторона Telegram).
const LONG_POLL_SECS: u64 = 30;
/// Максимум попыток доставки одного сообщения, после чего оно — `failed`.
const MAX_SEND_ATTEMPTS: i32 = 5;
/// Сколько сообщений забирать из outbox за один проход.
const OUTBOX_BATCH: i64 = 20;

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "telegram_bot=info".into()),
        )
        .init();

    let database_url = std::env::var("DATABASE_URL")
        .expect("переменная окружения DATABASE_URL обязательна (строка подключения PostgreSQL)");
    let store = Arc::new(
        Store::connect(&database_url)
            .await
            .unwrap_or_else(|e| panic!("не удалось подключиться к БД: {e:?}")),
    );
    tracing::info!("telegram-bot запущен; жду токен в настройках (settings)");

    let http = reqwest::Client::builder()
        .user_agent(concat!("telegram-bot/", env!("CARGO_PKG_VERSION")))
        .timeout(Duration::from_secs(LONG_POLL_SECS + 15))
        .build()
        .expect("не удалось собрать HTTP-клиент");

    let delivery = tokio::spawn(delivery_loop(store.clone(), http.clone()));
    let updates = tokio::spawn(updates_loop(store.clone(), http.clone()));

    tokio::select! {
        _ = tokio::signal::ctrl_c() => {
            tracing::info!("получен сигнал остановки, завершаюсь");
        }
        r = delivery => tracing::error!(?r, "цикл доставки завершился"),
        r = updates => tracing::error!(?r, "цикл обновлений завершился"),
    }
}

/// Текущий токен бота из БД (или None, если ещё не задан).
async fn current_token(store: &Store) -> Option<String> {
    match store.get_setting(SETTING_TELEGRAM_TOKEN).await {
        Ok(Some(t)) if !t.trim().is_empty() => Some(t.trim().to_string()),
        Ok(_) => None,
        Err(e) => {
            tracing::error!(?e, "не удалось прочитать токен из БД");
            None
        }
    }
}

// ───────────────────────── Доставка outbox ─────────────────────────

/// Бесконечный цикл доставки сообщений из `telegram_outbox`.
async fn delivery_loop(store: Arc<Store>, http: reqwest::Client) {
    loop {
        tokio::time::sleep(OUTBOX_POLL).await;

        let Some(token) = current_token(&store).await else {
            continue; // токен ещё не задан — ждём
        };

        let messages = match store.pending_messages(OUTBOX_BATCH).await {
            Ok(m) => m,
            Err(e) => {
                tracing::error!(?e, "не удалось получить очередь сообщений");
                continue;
            }
        };

        for msg in messages {
            match send_message(&http, &token, &msg.chat_id, &msg.text, msg.reply_markup.as_deref()).await {
                Ok(()) => {
                    if let Err(e) = store.mark_message_sent(msg.id).await {
                        tracing::error!(?e, id = msg.id, "не удалось пометить сообщение отправленным");
                    }
                }
                Err(e) => {
                    tracing::warn!(id = msg.id, error = %e, "ошибка отправки сообщения");
                    if let Err(e) = store
                        .mark_message_failed(msg.id, &e, MAX_SEND_ATTEMPTS)
                        .await
                    {
                        tracing::error!(?e, id = msg.id, "не удалось пометить сбой отправки");
                    }
                }
            }
        }
    }
}

/// Отправляет одно сообщение через Telegram Bot API. При наличии
/// `reply_markup` (JSON inline-клавиатуры) прикрепляет кнопки.
async fn send_message(
    http: &reqwest::Client,
    token: &str,
    chat_id: &str,
    text: &str,
    reply_markup: Option<&str>,
) -> Result<(), String> {
    let url = format!("https://api.telegram.org/bot{token}/sendMessage");
    let mut payload = serde_json::json!({ "chat_id": chat_id, "text": text });
    if let Some(markup) = reply_markup {
        // reply_markup хранится как JSON-строка — вставляем как объект.
        match serde_json::from_str::<serde_json::Value>(markup) {
            Ok(value) => {
                payload["reply_markup"] = value;
            }
            Err(e) => {
                tracing::warn!(error = %e, "reply_markup не является валидным JSON, шлю без кнопок");
            }
        }
    }
    let resp = http
        .post(&url)
        .json(&payload)
        .send()
        .await
        .map_err(|e| format!("запрос sendMessage: {e}"))?;
    if resp.status().is_success() {
        Ok(())
    } else {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        Err(format!("sendMessage вернул {status}: {body}"))
    }
}

// ───────────────────────── Обработка команд ─────────────────────────

/// Бесконечный цикл long-poll `getUpdates`. Подхватывает смену токена.
async fn updates_loop(store: Arc<Store>, http: reqwest::Client) {
    let mut offset: i64 = 0;
    let mut active_token: Option<String> = None;
    let mut last_token_check = tokio::time::Instant::now();

    loop {
        // Перечитываем токен периодически (и при первом запуске).
        if active_token.is_none() || last_token_check.elapsed() >= TOKEN_REFRESH {
            let fresh = current_token(&store).await;
            if fresh != active_token {
                tracing::info!("токен бота изменился, перезапускаю поллинг");
                offset = 0;
                if let Some(token) = fresh.as_deref() {
                    cache_bot_username(&store, &http, token).await;
                }
            }
            active_token = fresh;
            last_token_check = tokio::time::Instant::now();
        }

        let Some(token) = active_token.clone() else {
            tokio::time::sleep(Duration::from_secs(5)).await;
            continue;
        };

        match get_updates(&http, &token, offset).await {
            Ok(updates) => {
                for update in updates {
                    offset = offset.max(update.update_id + 1);
                    if let Some(message) = update.message {
                        handle_message(&store, message).await;
                    }
                    if let Some(callback) = update.callback_query {
                        handle_callback(&store, &http, &token, callback).await;
                    }
                }
            }
            Err(e) => {
                tracing::warn!(error = %e, "ошибка getUpdates");
                tokio::time::sleep(Duration::from_secs(5)).await;
            }
        }
    }
}

/// Узнаёт username бота через `getMe` и кэширует его в настройках (для UI и
/// deep-link `t.me/<bot>?start=<code>`).
async fn cache_bot_username(store: &Store, http: &reqwest::Client, token: &str) {
    let url = format!("https://api.telegram.org/bot{token}/getMe");
    let resp = match http.get(&url).send().await {
        Ok(r) => r,
        Err(e) => {
            tracing::warn!(error = %e, "getMe не удался");
            return;
        }
    };
    let body: serde_json::Value = match resp.json().await {
        Ok(b) => b,
        Err(e) => {
            tracing::warn!(error = %e, "разбор getMe не удался");
            return;
        }
    };
    if let Some(username) = body
        .get("result")
        .and_then(|r| r.get("username"))
        .and_then(|u| u.as_str())
    {
        if let Err(e) = store.set_setting(SETTING_TELEGRAM_USERNAME, username).await {
            tracing::warn!(?e, "не удалось сохранить username бота");
        } else {
            tracing::info!(username, "username бота определён");
        }
    }
}

/// Обрабатывает входящее сообщение: команды `/start <code>` и `/unlink`.
async fn handle_message(store: &Store, message: Message) {
    let Some(text) = message.text.as_deref() else {
        return;
    };
    let chat_id = message.chat.id.to_string();
    let text = text.trim();

    if let Some(rest) = text.strip_prefix("/start") {
        let code = rest.trim();
        if code.is_empty() {
            enqueue(
                store,
                &chat_id,
                "Привет! Чтобы привязать аккаунт, откройте привязку в лаунчере или \
                 веб-админке и нажмите кнопку — я открою этот чат с кодом автоматически.",
            )
            .await;
            return;
        }
        match store.link_telegram_by_code(code, &chat_id).await {
            Ok(username) => {
                enqueue(
                    store,
                    &chat_id,
                    &format!(
                        "Готово! Этот Telegram привязан к аккаунту «{username}». \
                         Сюда будут приходить коды входа и уведомления."
                    ),
                )
                .await;
            }
            Err(_) => {
                enqueue(
                    store,
                    &chat_id,
                    "Код недействителен или истёк. Сгенерируйте новый код привязки.",
                )
                .await;
            }
        }
    } else if text.starts_with("/unlink") {
        match store.unlink_telegram_by_chat(&chat_id).await {
            Ok(true) => enqueue(store, &chat_id, "Telegram отвязан от аккаунта.").await,
            Ok(false) => {
                enqueue(store, &chat_id, "К этому чату не привязан ни один аккаунт.").await
            }
            Err(e) => tracing::error!(?e, "ошибка отвязки"),
        }
    }
}

/// Кладёт ответ в outbox (ответы боту шлём через ту же очередь).
async fn enqueue(store: &Store, chat_id: &str, text: &str) {
    if let Err(e) = store.enqueue_message(chat_id, text).await {
        tracing::error!(?e, "не удалось поставить ответ в очередь");
    }
}

/// Обрабатывает нажатие inline-кнопки подтверждения («✅ Это я» / «🚫 Это не я»).
///
/// `callback_data` имеет вид `<ok|no>:<challenge>`. Бот помечает challenge в БД
/// (через `answer_challenge`), отвечает на сам callback, чтобы убрать «часики» у
/// кнопки, и шлёт пользователю текстовое подтверждение результата.
async fn handle_callback(
    store: &Store,
    http: &reqwest::Client,
    token: &str,
    callback: CallbackQuery,
) {
    let CallbackQuery { id, data, from, message } = callback;
    // chat_id для проверки владельца берём из чата сообщения с кнопкой; если
    // его нет (редко) — падаем на id пользователя.
    let chat_id = message
        .as_ref()
        .map(|m| m.chat.id.to_string())
        .unwrap_or_else(|| from.id.to_string());

    let Some(data) = data else {
        answer_callback(http, token, &id, None).await;
        return;
    };
    let Some((action, challenge)) = data.split_once(':') else {
        answer_callback(http, token, &id, None).await;
        return;
    };
    let approve = match action {
        CALLBACK_APPROVE => true,
        CALLBACK_DENY => false,
        _ => {
            answer_callback(http, token, &id, None).await;
            return;
        }
    };

    match store.answer_challenge(challenge, &chat_id, approve).await {
        Ok(ChallengeAnswer::Done { approve, username }) => {
            let toast = if approve { "Подтверждено" } else { "Отклонено" };
            answer_callback(http, token, &id, Some(toast)).await;
            let text = if approve {
                format!("Вход в аккаунт «{username}» подтверждён. Можно вернуться в приложение.")
            } else {
                format!(
                    "Запрос на вход в аккаунт «{username}» отклонён. Если это были не вы — \
                     рекомендуем сменить пароль."
                )
            };
            enqueue(store, &chat_id, &text).await;
        }
        Ok(ChallengeAnswer::Stale) => {
            answer_callback(http, token, &id, Some("Запрос устарел")).await;
        }
        Ok(ChallengeAnswer::Forbidden) => {
            answer_callback(http, token, &id, Some("Это не ваш запрос")).await;
        }
        Err(e) => {
            tracing::error!(?e, "ошибка обработки callback");
            answer_callback(http, token, &id, None).await;
        }
    }
}

/// Отвечает на `callback_query` (убирает индикатор загрузки у кнопки и
/// показывает короткое всплывающее уведомление).
async fn answer_callback(
    http: &reqwest::Client,
    token: &str,
    callback_id: &str,
    text: Option<&str>,
) {
    let url = format!("https://api.telegram.org/bot{token}/answerCallbackQuery");
    let mut payload = serde_json::json!({ "callback_query_id": callback_id });
    if let Some(text) = text {
        payload["text"] = serde_json::Value::String(text.to_string());
    }
    if let Err(e) = http.post(&url).json(&payload).send().await {
        tracing::warn!(error = %e, "answerCallbackQuery не удался");
    }
}

/// Запрашивает обновления через long-poll.
async fn get_updates(
    http: &reqwest::Client,
    token: &str,
    offset: i64,
) -> Result<Vec<Update>, String> {
    let url = format!("https://api.telegram.org/bot{token}/getUpdates");
    let resp = http
        .get(&url)
        .query(&[
            ("offset", offset.to_string()),
            ("timeout", LONG_POLL_SECS.to_string()),
        ])
        .send()
        .await
        .map_err(|e| format!("запрос getUpdates: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("getUpdates вернул {}", resp.status()));
    }
    let body: GetUpdatesResponse = resp
        .json()
        .await
        .map_err(|e| format!("разбор getUpdates: {e}"))?;
    if !body.ok {
        return Err("getUpdates: ok=false".to_string());
    }
    Ok(body.result)
}

// ───────────────────── Модель ответов Bot API ─────────────────────

#[derive(serde::Deserialize)]
struct GetUpdatesResponse {
    ok: bool,
    #[serde(default)]
    result: Vec<Update>,
}

#[derive(serde::Deserialize)]
struct Update {
    update_id: i64,
    message: Option<Message>,
    callback_query: Option<CallbackQuery>,
}

#[derive(serde::Deserialize)]
struct Message {
    chat: Chat,
    text: Option<String>,
}

#[derive(serde::Deserialize)]
struct Chat {
    id: i64,
}

#[derive(serde::Deserialize)]
struct CallbackQuery {
    id: String,
    #[serde(default)]
    data: Option<String>,
    from: CallbackFrom,
    #[serde(default)]
    message: Option<Message>,
}

#[derive(serde::Deserialize)]
struct CallbackFrom {
    id: i64,
}
