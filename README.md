# Stardust

Приватная платформа Minecraft с собственным десктопным лаунчером, auth/Yggdrasil-сервисом, доставкой curated-сборки, веб-админкой, Telegram-интеграцией и общим NeoForge-модом.

Проект рассчитан прежде всего на управляемую сборку и сервер, а не на каталог произвольных модпаков.

## Компоненты

| Путь | Назначение | Стек |
| --- | --- | --- |
| `launcher/` | Лаунчер: onboarding, логин, 2FA, скин, синхронизация сборки, запуск Minecraft, диагностика и самообновление | Tauri 2, Rust, React, TypeScript |
| `crates/auth-server/` | Регистрация, сессии, Telegram flows, API профиля, скины, статистика, crash reports и Yggdrasil/sessionserver | Rust, Axum, PostgreSQL |
| `crates/admin-server/` | Admin API для аккаунтов, сборок, файлов, настроек, SFTP-деплоя и server telemetry | Rust, Axum, PostgreSQL |
| `admin-web/` | Desktop и mobile web-админка | React, TypeScript, Vite |
| `website/` | Публичный сайт проекта и скачивание лаунчера | Vite, JavaScript, CSS |
| `stardust-mod/` | NeoForge-мод клиента и dedicated server: TAB, чат, кастомизация, телеметрия, crash markers и challenges | Java 21, NeoForge |
| `crates/store/` | PostgreSQL storage, миграции, сборки, Telegram outbox, статистика и telemetry | Rust, sqlx |
| `crates/protocol/` | Общие DTO API и формат `Manifest` | Rust, serde |
| `crates/telegram-bot/` | Telegram 2FA, уведомления и доставка queued-документов | Rust |
| `docs/` | Архитектура, roadmap, инструкции по macOS и modpack | Markdown |

`website` и `admin-web` — разные приложения и разные Docker-контейнеры (`launcher-website` и `launcher-admin-web`). Публичный сайт предназначен игрокам; управление аккаунтами, сборками и контентом выполняется через отдельную админку и `admin-server`.

## Реализовано

### Лаунчер

- регистрация, логин, автологин и logout;
- Telegram 2FA, passwordless-вход и сброс пароля;
- хранение bearer-токена в системном keyring;
- offline/degraded поведение с сохранением локальной сессии и очередью статистики;
- запуск Minecraft 1.21.1 через NeoForge;
- скачивание клиента, библиотек, assets, natives и Java 21;
- защита от второй копии игры и восстановление незавершенной игровой сессии;
- синхронизация curated-сборки по manifest и SHA-1;
- optional-моды, `.dis`, сохранение пользовательских конфигов и удаление измененных managed-файлов с защитой от потери правок;
- конфликты optional-модов, включая Distant Horizons/Voxy;
- настройки памяти JVM, concurrency, прокси, Java и папки данных;
- импорт, загрузка и 3D-просмотр скинов, включая classic/slim и плащ;
- самообновление Windows/macOS/Linux через GitHub Releases с retry, resume и необязательной SHA-256-проверкой;
- просмотр логов, crash reports, marker-диагностика и отправка crash telemetry администраторам.

### Backend и auth

- PostgreSQL-хранилище аккаунтов, сессий, сборок, новостей, косметики, Telegram challenges, статистики и telemetry;
- Argon2 для паролей с поддержкой миграции старых SHA-256 записей;
- persistent sessions с хешированием токенов в базе;
- Yggdrasil `authenticate`, `refresh`, `validate`, `invalidate`, `join`, `hasJoined`, profile и textures;
- server-side ban, который блокирует вход в Minecraft, но не сам лаунчер;
- импорт и загрузка скинов/плащей;
- новости с Markdown, закреплением и отметкой прочтения;
- server customization API для бейджей, цветов и градиентов;
- crash reports, server logs, Telegram outbox и отправка документов администраторам.

### Сборки и админка

- CRUD, clone и activation сборок;
- manifest-файлы с `side`, `kind`, `sha1`, `size`, `overwrite`, optional metadata и конфликтами;
- content-addressed хранение файлов;
- файловый менеджер, загрузка крупных файлов, редактирование текстовых файлов;
- build-check и deps-check;
- аккаунты, поиск, фильтры, роли, баны, Telegram binding, скины и косметика;
- SFTP-деплой server/both файлов с atomic upload, progress polling и known-host fingerprint;
- server telemetry: online, TPS, MSPT, join/quit и server logs;
- desktop и mobile entrypoints админки.

## Быстрый старт

Rust закреплен в `rust-toolchain.toml` (1.96), Node и Java-версии для CI указаны в `Makefile`.

```sh
make help
make ci
```

Основные команды:

```sh
make test-backend          # тесты backend crates
make build-launcher-frontend
make build-admin-web
make build-website
make build-mod
make ci                    # backend, launcher clippy, web-сборки и mod
make ci-launcher           # полная сборка лаунчера и артефактов
```

Локальный запуск:

```sh
cargo run -p auth-server
ADMIN_BIND=127.0.0.1:8081 DATABASE_URL=postgres://... cargo run -p admin-server
cd launcher && npm ci && npm run tauri dev
```

Для dev-адресов используются `LAUNCHER_AUTH_URL` и `LAUNCHER_ADMIN_URL`. Admin web запускается через `make dev-admin-web`, публичный сайт — через `make dev-website`.

Подробности по production-схеме находятся в [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md), установка macOS — в [`docs/MACOS_INSTALL.md`](docs/MACOS_INSTALL.md), структура roadmap — в [`docs/ROADMAP.md`](docs/ROADMAP.md).

## CI и релизы

| Workflow | Назначение |
| --- | --- |
| `ci.yml` | Быстрые проверки на push/PR в `master` |
| `backend.yml` | Backend tests, Docker images и deploy на `master` |
| `launcher-release.yml` | Релизные установщики по тегу `vX.Y.Z` |
| `launcher-build.yml` | Ручная debug-сборка лаунчера |
| `mod-release.yml` | JAR мода по тегу `mod-v*` |

Исходная версия лаунчера остается `0.0.0`; версия релиза определяется git-тегом. Для patch-релиза используется `sh scripts/release.sh`, для локальной полной проверки — `make ci-launcher`.

## Текущие ограничения

- launcher фактически запускает NeoForge 1.21.1, несмотря на более широкий enum loader-ов в protocol;
- telemetry и server logs пока рассчитаны на один Minecraft-сервер;
- optional dependencies/conflicts хранятся в manifest, но не образуют полноценный dependency resolver;
- у сессий нет полноценного TTL/device management;
- updater может продолжить установку, если `.sha256` отсутствует или не удалось скачать checksum;
- нет полноценного audit log действий администраторов, release health и rollback сборок;
- content-addressed storage пока не имеет безопасного garbage collection.

Актуальный список задач и порядок приоритетов ведется в [`docs/ROADMAP.md`](docs/ROADMAP.md).
