# API загрузки модов в сборку (v1)

Программный HTTP API для машин: CI, скриптов и MCP-клиентов. Отдельный
namespace `/api/v1`: свои токены, стабильные JSON-схемы и машинные коды
ошибок. Веб-админка продолжает пользоваться старыми эндпоинтами.

## Авторизация

Пароль админа и игровой server-token здесь **не** принимаются. Нужен
API-токен вида `sd_` + 64 hex-символа (32 случайных байта).

- В заголовке: `Authorization: Bearer sd_…`.
- В БД хранится только SHA-256 хеш токена; полный токен показывается
  ровно один раз при создании.
- Токен привязан к аккаунту админа. Бан или снятие роли `admin` отключают
  его автоматически.
- Хеши сравниваются в постоянном времени.
- Повторная отправка одного и того же файла не создаёт дубликат.

### Как выдать первый токен

1. **Bootstrap из окружения** (для первого запуска/CI):
   `ADMIN_API_TOKEN=sd_<64 hex>` и `ADMIN_API_TOKEN_ADMIN=<логин админа>`
   (или первый логин из `ADMIN_BOOTSTRAP`). При старте сервер заводит токен
   идемпотентно; сам токен в логи не пишется. Генерировать можно так:
   `printf 'sd_'; openssl rand -hex 32`.
2. **Через админ-сессию**: `POST /api/api-tokens` (см. ниже) с
   `Authorization: Bearer <сессия админки>`.

Дальше токенами управляют через `/api/api-tokens` под обычной админ-сессией.

## Эндпоинты

### `POST /api/v1/builds/:id/mods` — загрузить мод

Аутентификация: API-токен. Тело: `multipart/form-data`.

| Поле   | Обязательно | Описание |
|--------|-------------|----------|
| `file` | да          | JAR-файл. Ровно один за запрос. |
| `meta` | нет         | JSON с переопределениями (см. ниже). |

`meta` (все поля необязательны):

```json
{
  "path": "mods/sodium-0.6.13.jar",
  "side": "both",
  "modId": "sodium",
  "displayName": "Sodium",
  "description": "Fast renderer",
  "optional": false,
  "enabledByDefault": true,
  "overwrite": true,
  "profiles": ["performance"]
}
```

- `path` — путь в сборке. Без него берётся `mods/<имя из multipart>`.
  Если задан, обязан лежать в `mods/` и оканчиваться на `.jar`.
- `modId`/`displayName`/`description` переопределяют значения из JAR.
- `side`: `client` | `server` | `both` (по умолчанию `both`).
- `profiles` — ключи профилей модов (пусто = общий файл).

**Проверки JAR** (выполняются всегда, при любых `meta`):

- файл — корректный zip/JAR;
- есть метаданные для загрузчика сборки:
  - `neoforge`/`forge` → `META-INF/neoforge.mods.toml` или
    `META-INF/mods.toml` с непустым `[[mods]].modId`;
  - `fabric`/`quilt` → `fabric.mod.json` с непустым `id`;
  - JAR чужого загрузчика отклоняется;
- метаданные читаются с потолком 1 МиБ (защита от zip-бомб);
- имя файла — только basename из безопасного набора, без `..` и путей;
- размер — не больше 256 МиБ (`413 payload_too_large`);
- сборка на `vanilla` моды не принимает (`loader_does_not_support_mods`).

SHA-1 считается на сервере; байты складываются в контент-адресное
хранилище под именем `sha1`. Версия берётся из TOML/`fabric.mod.json`,
а для `${file.jarVersion}` — из `META-INF/MANIFEST.MF`.

**Ответ `201 Created`** (новая запись) или **`200 OK`** (дубликат):

```json
{
  "fileId": 42,
  "path": "mods/sodium-0.6.13.jar",
  "sha1": "6f1e…",
  "sizeBytes": 123456,
  "side": "both",
  "kind": "mod",
  "overwrite": true,
  "optional": false,
  "enabledByDefault": true,
  "disabled": false,
  "modId": "sodium",
  "displayName": "Sodium",
  "description": "Fast renderer",
  "profiles": [],
  "loader": "neoforge",
  "modVersion": "0.6.13",
  "created": true,
  "duplicate": false,
  "removedOldVersions": 0
}
```

- `duplicate: true` — такое же содержимое (по SHA-1) уже было в сборке;
  вернули существующую запись, ничего не меняя.
- `created: false` — путь уже был занят другим файлом; запись заменена
  (как при повторной загрузке через UI). Сбрасываются прежние свойства
  файла, поэтому агент передаёт их в `meta`.
- `removedOldVersions` — сколько файлов с тем же `modId`, но другим путём
  удалено (замена версии мода).

**Коды ошибок** (`{"error": "...", "code": "..."}`, `code` стабилен):

| HTTP | `code` | Когда |
|------|--------|-------|
| 401 | `missing_token` | нет заголовка `Authorization` |
| 401 | `invalid_token` | токен неверен, отозван или истёк |
| 403 | `account_banned` | аккаунт владельца заблокирован |
| 403 | `not_admin` | владелец токена больше не админ |
| 400 | `invalid_multipart` | битый multipart |
| 400 | `invalid_meta` | `meta` — не JSON или не та схема |
| 400 | `missing_file` / `too_many_files` | нет `file` / больше одного |
| 400 | `invalid_side` / `invalid_path` / `invalid_filename` | невалидные поля |
| 400 | `invalid_jar` | не zip/JAR |
| 400 | `missing_mod_metadata` | в JAR нет метаданных |
| 400 | `wrong_loader` | JAR другого загрузчика |
| 400 | `invalid_mod_metadata` / `missing_mod_id` | метаданные битые/без id |
| 400 | `loader_does_not_support_mods` | сборка на `vanilla` |
| 404 | `build_not_found` | нет такой сборки |
| 413 | `payload_too_large` | JAR больше 256 МиБ |
| 429 | `rate_limited` | больше 30 загрузок в минуту с IP |
| 500 | — | внутренняя ошибка (без деталей) |

### `GET /api/api-tokens` — список токенов

Аутентификация: **админ-сессия** (не API-токен). Возвращает
`{"tokens": [...]}`; секретов в ответе нет — только `tokenPrefix`,
`lastUsedAt`, `revokedAt`, `expiresAt`, `active`.

### `POST /api/api-tokens` — создать токен

Аутентификация: **админ-сессия**. Тело:

```json
{ "name": "mod-sync agent", "expiresInDays": 90 }
```

`expiresInDays` необязателен (1–3650; без него — бессрочный).

Ответ `201`:

```json
{
  "token": "sd_…",
  "tokenInfo": { "id": 7, "name": "mod-sync agent", "tokenPrefix": "sd_1a2b3c4d", "active": true, "...": "…" }
}
```

Полный `token` приходит **только здесь**. Сохраните его сразу.

### `DELETE /api/api-tokens/:id` — отозвать токен

Аутентификация: **админ-сессия**. Идемпотентно: повторный отзыв не
ошибка. `404 token_not_found` — если такого id нет.
Ответ: `{"ok": true}`.

## Аудит и логи

Каждая загрузка пишет строку в `admin_api_audit`: id токена, UUID и ник
владельца, действие, `build_id`/`file_id`/`sha1`/путь. В журналах сервера
— `token_id`, ник, сборка, sha1 и размер; сам токен не логируется никогда.

## MCP-клиентам

Тонкая обёртка над HTTP: инструменты `upload_mod` и (опционально)
`list_builds`. Рекомендуемая схема инструмента:

```json
{
  "name": "upload_mod",
  "description": "Загрузить NeoForge-мод (JAR) в сборку StarDust",
  "inputSchema": {
    "type": "object",
    "required": ["buildId", "file"],
    "properties": {
      "buildId": { "type": "integer" },
      "file": { "type": "string", "description": "mimeType: application/java-archive" },
      "side": { "enum": ["client", "server", "both"] },
      "modId": { "type": "string" },
      "optional": { "type": "boolean" }
    }
  }
}
```

Практические правила для агента:

- указывайте `modId` из метаданных, чтобы старая версия мода удалилась;
- повтор после сетевой ошибки безопасен: дубликат вернёт `200`;
- `429` — подождите минуту; `401 invalid_token` — токен отозван, нужен
  новый (через админку), повторять бессмысленно;
- поле `code` — для ветвления логики, `error` — для показа человеку.

## Ограничения

- Один JAR на запрос; лимит 30 загрузок/минуту на IP.
- Лимит тела — 256 МиБ (общий JSON-лимит сервера для остальных маршрутов
  — 16 МиБ).
- Загрузка идёт в существующую сборку; создание сборок через v1 не
  предусмотрено.
