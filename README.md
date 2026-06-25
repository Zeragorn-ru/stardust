# Minecraft Launcher & Auth Platform

Приватная экосистема для Minecraft-сервера: кастомный лаунчер, собственная
авторизация (Yggdrasil-совместимая) и веб-админка для управления сборкой.

## Компоненты (монорепо)

| Папка          | Что это                                                            | Стек              |
| -------------- | ------------------------------------------------------------------ | ----------------- |
| `launcher/`    | Десктоп-лаунчер: логин, обновление сборки, запуск игры             | Tauri (Rust + TS) |
| `auth-server/` | Yggdrasil-совместимый сервер авторизации                          | Rust (Axum)       |
| `admin/`       | Admin API: управление сборкой, статистика, пользователи            | Rust (Axum)       |
| `admin-web/`   | Веб-админка                                                         | React + TS        |
| `file-server/` | Раздача файлов сборки и манифеста                                  | nginx             |
| `mc-server/`   | Контейнер Minecraft-сервера с authlib-injector                    | Docker + Java     |
| `stardust-mod/` | Общий Fabric-мод, один jar для клиента и сервера                  | Java + Fabric     |
| `crates/`      | Общий Rust-код (типы протокола и манифеста)                        | Rust              |
| `docs/`        | Архитектура и протоколы                                            | —                 |

## Как это работает (кратко)

1. **Авторизация.** Лаунчер логинит игрока на `auth-server` (а не на Mojang).
   И клиент, и MC-сервер используют `authlib-injector`, перенаправляющий
   проверку сессий на наш `auth-server`. Сервер остаётся в `online-mode=true`.

2. **Сборка — единый источник правды.** Все моды/конфиги лежат в общем volume
   `modpack-data`. У каждого файла есть «сторона» (`client` / `server` / `both`).
   Админка редактирует сборку → пересобирается `manifest.json`.

3. **Доставка обновлений.** Лаунчер скачивает `manifest.json`, сравнивает SHA-1
   хеши с локальными файлами и докачивает только изменённое. MC-сервер монтирует
   свою (`server` + `both`) часть из того же volume.

Подробнее — в [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## Порядок разработки

Идём от клиента к серверу, чтобы на каждом шаге был запускаемый результат:

1. **Лаунчер: интерфейс** — экраны входа/регистрации, профиль, скин (3D),
   настройки, прогресс. *(готово, на заглушках)*
2. **Бекенд: аккаунты и авторизация** — регистрация/вход без почты, случайный
   UUID на сервере, bearer-сессии с проверкой `/api/session`, серверное
   хранение скинов по аккаунтам, импорт скина с лицензии Mojang и дальнейшая
   Yggdrasil-совместимость.
3. **Лаунчер: updater + запуск** — манифест, докачка по SHA-1, менеджер JRE,
   подготовка vanilla Minecraft, передача ника/UUID/accessToken и запуск JVM.
   Для настоящих серверных скинов следующим шагом подключается
   authlib-injector + Yggdrasil/sessionserver endpoints на `auth-server`.
4. *(позже)* **Веб-админка и управление сервером** — CRUD сборки и генерация
   манифеста, статистика, аккаунты. Серверную панель либо пишем свою, либо
   берём готовую (напр. [Catalyst](https://catalystctl.com)). **Пока не делаем.**

Подробная разбивка по задачам — в [`docs/ROADMAP.md`](docs/ROADMAP.md).

## Разработка

Backend и shared-код — это Cargo workspace (см. корневой `Cargo.toml`).
Сейчас в воркспейсе есть общий crate `protocol`, `auth-server` и Tauri-бэкенд
лаунчера (`launcher/src-tauri`).

### Запуск auth-сервера

```sh
cargo run -p auth-server
```

По умолчанию сервер слушает `127.0.0.1:8080`. Если порт занят:

```sh
AUTH_BIND=127.0.0.1:8090 cargo run -p auth-server
```

Тогда лаунчер надо запускать с тем же адресом:

```sh
LAUNCHER_AUTH_URL=http://127.0.0.1:8090 npm run tauri dev
```

### Сборка backend (Rust)

```sh
cargo build            # собрать весь воркспейс
cargo build -p auth-server
cargo build -p protocol
```

### Запуск лаунчера (dev)

```sh
cd launcher
npm install            # один раз
npm run tauri dev      # запускает Vite + Tauri-окно
```

### Самообновление лаунчера

Лаунчер обновляется через `tauri-plugin-updater`. Эндпоинт берётся из
`tauri.conf.json` (`plugins.updater.endpoints`), но его можно переопределить
переменной окружения:

```sh
LAUNCHER_UPDATE_URL=http://127.0.0.1:8080/updates/{{target}}/{{arch}}/{{current_version}} npm run tauri dev
```

Проверка и установка доступны в настройках лаунчера (раздел «Обновления»).

**Подписи.** Обновления проверяются публичным ключом из
`launcher/src-tauri/tauri.conf.json`. Приватный ключ лежит в
`launcher/src-tauri/.tauri-signing.key` и **не коммитится** (в `.gitignore`).
Чтобы собрать подписанные артефакты:

```sh
cd launcher
# пароль ключа — в TAURI_SIGNING_PRIVATE_KEY_PASSWORD (пусто, если не задан)
set TAURI_SIGNING_PRIVATE_KEY=src-tauri/.tauri-signing.key
set TAURI_SIGNING_PRIVATE_KEY_PASSWORD=
npm run tauri build
```

Это создаст инсталлятор и `*.sig` рядом с ним; их вместе с `latest.json`
(манифест обновления) нужно выложить на сервер обновлений.

Новый ключ при необходимости генерируется командой
`npm run tauri signer generate -- -w src-tauri/.tauri-signing.key`; публичную
часть из `.tauri-signing.key.pub` затем кладут в `plugins.updater.pubkey`.

> При деинсталляции (Windows/NSIS) лаунчер спросит, удалять ли данные из
> `%APPDATA%\com.project.launcher` (Java, клиент, NeoForge, ассеты, настройки).
> По умолчанию данные сохраняются.

> Статус: каркас проекта. Сервисы реализуются по шагам (см. `docs/ROADMAP.md`).
