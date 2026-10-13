# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Что это

Приватная Minecraft-платформа: десктопный лаунчер, auth/Yggdrasil-бэкенд, веб-админка, публичный сайт и общий NeoForge-мод. Проект про управляемую curated-сборку, а не каталог произвольных модпаков. Документация в репозитории — на русском; отвечай и комментируй в том же стиле, что и окружающий код.

## Команды

Все команды — из корня репозитория (cargo workspace), не из подкаталогов пакетов. `make help` показывает все цели.

Проверки перед коммитом (по зоне изменений):

- `make ci` — полный набор быстрых проверок, как в `ci.yml` (backend-тесты, оба clippy, сборки admin-web/website/mod).
- `make test-backend` — тесты backend-крейтов; один тест: `cargo test -p store <имя>` или `cargo test -p launcher <имя>`.
- `make clippy-launcher` — clippy лаунчера профилем `launcher-release` с `-D warnings`. Не заменяй на `cargo clippy --all-targets`: он падает на старом тесте `minecraft.rs` (не твой код — не чинить).
- `make build-launcher-frontend` — `tsc` + vite build; проверка любых изменений React/TS/CSS лаунчера.
- `make build-admin-web`, `make build-website`, `make build-mod` — по зонам.

Запуск локально:

- `cargo run -p auth-server` — 127.0.0.1:8080.
- `ADMIN_BIND=127.0.0.1:8081 DATABASE_URL=postgres://... cargo run -p admin-server`.
- `make dev-launcher` (Tauri dev), `make dev-admin-web` (:1430), `make dev-website` (:5173).
- dev-адреса лаунчера переопределяются `LAUNCHER_AUTH_URL` / `LAUNCHER_ADMIN_URL`.

## Архитектура

Rust workspace (`crates/` + `launcher/src-tauri`):

- `crates/protocol` — общие DTO API и формат `Manifest`; потребители — оба сервера и Rust-бэкенд лаунчера. Изменение полей требует проверки всех Rust- и TS-потребителей (JSON-поля читает и фронтенд).
- `crates/store` — PostgreSQL (sqlx), миграции, все хранимые данные.
- `crates/auth-server` — регистрация, сессии, Yggdrasil/sessionserver, скины, Telegram 2FA. MC-сервер работает в `online-mode=true`: authlib-injector подменяет URL Mojang на этот сервер (на клиенте через лаунчер, на сервере через `-javaagent`).
- `crates/admin-server` — API админки: аккаунты, сборки, manifest-файлы, SFTP-деплой, telemetry.
- `crates/telegram-bot` — 2FA, уведомления, outbox-доставка документов.
- `launcher/src-tauri` — `commands.rs` (мост Tauri-команды/флоу авторизации), `modpack.rs` (sync манифеста), `minecraft.rs` (Java/NeoForge runtime), `update.rs` (самообновление), `paths.rs` (каталог данных, portable mode).

Лаунчер — два мира в одном пакете: `src/` (React/TS UI, `api.ts` вызывает Tauri-команды с browser-fallbackами) и `src-tauri/src/` (Rust). Состояние передаётся через Tauri-команды, фронтенд не лезет в файлы напрямую.

Синхронизация модпака: manifest по SHA-1; выключенный optional-мод — файл с суффиксом `.dis` (NeoForge грузит только `.jar`); `managed-files.json` защищает пользовательские правки конфигов; `mod-choices.json` + `selected-profile.json` — выборы игрока (запись под CHOICES_LOCK от lost update); `cached-manifest.json` — фоллбэк при сбоях сети. Профили модов взаимоисключающие, один всегда выбран; гейт в `file_enabled` (modpack.rs) накрывает ВСЕ файлы с тегами профиля, включая неопциональные — опциональность лишь добавляет ручной тумблер.

`admin-web` и `website` — разные приложения и разные Docker-контейнеры (`launcher-admin-web`, `launcher-website`). Админка имеет desktop- и mobile-точки входа (`src/mobile/`, `mobile.css`).

## CI/CD и релизы

- `ci.yml` — быстрые проверки на push/PR.
- `backend.yml` — тесты backend, Docker-образы → ghcr.io, автодеплой на master (path-фильтр: `crates/`, `admin-web/`, `website/` и т.п.). Коммиты только по `launcher/` его не триггерят — это норма, не жди job. Ручной деплой: `make docker-update`.
- `launcher-release.yml` — по тегу `vX.Y.Z`: шаг «Set version from tag» сам перезаписывает версию в файлах workspace и собирает установщики. Релиз публикуется как pre-release, alias `launcher-beta` обновляется автоматически (latest.json); продвижение в stable — вручную из админки.
- `launcher-sandbox-check.yml` — Arch-контейнер, read-only сценарий каталога логов (регрессия паники tracing-appender в песочницах типа Gear Lever/Flatpak).
- `launcher-build.yml` — ручная debug-сборка; `mod-release.yml` — JAR мода по тегу `mod-v*`.

Версия: источник правды — git-тег; версия в исходниках — плейсхолдер и может отставать. Не бампай файлы руками для релиза. Теги создавать только по явной просьбе пользователя: `sh scripts/release.sh [patch|minor|major|X.Y.Z]` (есть `--dry-run`/`--no-push`).

## Git

- Коммить только файлы текущей задачи; перед правками проверь `git status --short` и не откатывай чужие незакоммиченные изменения.
- Короткие conventional-сообщения: `fix: improve admin mobile editor`.
- Не пушь без явной просьбы; `git reset --hard` / force-push — только с прямого разрешения.
- `dist/`, `target/`, архивы, секреты и сгенерированные артефакты — не в коммиты.

## Известные грабли

- macOS titlebar: окно создаётся Titled+Overlay из `tauri.macos.conf.json`. Не добавляй рантайм-переключения декораций — они ломали раскладку (tao применяет set_decorations через async main-queue). Геометрию полосы настраивает `macos_titlebar::apply` после применения стилей. UI на macOS проверяется только релизом от пользователя, локально окно не запускать.
- Логи лаунчера пишутся рядом с бинарём (`logs/`, ротация `rolling::daily`). В песочницах каталог read-only, а `rolling::daily` паникует при создании каталога — поэтому в `lib.rs` перед ним обязательна проверка записываемости; при read-only логи идут в stdout.
- `crates/bootstrap` исключён из workspace — собирается отдельно (`make bootstrap`).
- telemetрия и server logs рассчитаны на один Minecraft-сервер; optional-зависимости в манифесте не образуют dependency resolver.
