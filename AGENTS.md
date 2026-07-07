# Stardust Agent Guide

Эта инструкция для OpenCode и других AI-агентов, которые работают с репозиторием Stardust.

## Базовые правила

- Работай из корня репозитория: `/opt/stardust`.
- Перед изменениями проверь контекст: `git status --short`, релевантные файлы, существующие паттерны.
- Не откатывай чужие незакоммиченные изменения без прямого разрешения пользователя.
- Не коммить локальные артефакты, архивы, build-output и секреты.
- Backend, launcher, admin-web и modpack связаны, поэтому после изменения общих типов проверяй все потребители.
- Версия лаунчера в исходниках остаётся `0.0.0`; источник правды для релиза лаунчера — git-тег `vX.Y.Z`.

## Структура проекта

- `crates/store` — PostgreSQL-хранилище, миграции, общие методы доступа к данным.
- `crates/protocol` — общие Rust DTO/API-типы для серверов и launcher Tauri backend.
- `crates/auth-server` — auth/Yggdrasil API, пользовательские endpoints, Telegram 2FA, фоновая синхронизация статистики.
- `crates/admin-server` — API админки и операции управления сервером/сборками.
- `launcher` — Tauri launcher: React frontend и Rust backend.
- `admin-web` — веб-админка: desktop и mobile entrypoints.
- `stardust-mod` — Minecraft/NeoForge mod.
- `Makefile` — единая точка входа для локальных сборок (`make help`).
- `scripts/ci/` — скрипты, общие для CI и локальной отладки.
- `packaging/` — заготовки PKGBUILD, RPM spec, Homebrew, Flatpak.

## CI/CD

| Workflow | Триггер | Назначение |
|----------|---------|------------|
| `ci.yml` | push/PR master, workflow_dispatch | Быстрые проверки без релизов |
| `backend.yml` | push master (path filter), workflow_dispatch | Тесты, Docker → ghcr.io, деплой |
| `launcher-release.yml` | тег `v*`, workflow_dispatch | Релизные установщики → GitHub Releases |
| `launcher-build.yml` | workflow_dispatch | Отладочная сборка лаунчера + артефакты Actions |
| `mod-release.yml` | тег `mod-v*`, workflow_dispatch | JAR мода → GitHub Releases |

Этапы сборки лаунчера разбиты на composite actions в `.github/actions/launcher-*/` — см. `.github/actions/README.md`.

Rust закреплён в `rust-toolchain.toml` (1.96.0). Локально: `make ci` повторяет проверки из `ci.yml`.

## Проверки перед коммитом

Минимум выбирай по зоне изменений (или `make ci` / `make ci-launcher`):

- Rust backend/protocol/store: `cargo test -p auth-server -p admin-server -p telegram-bot -p store -p protocol` или `make test-backend`.
- Launcher Rust backend: `make clippy-launcher` и `cargo build -p launcher`.
- Launcher frontend/Tauri app: `make build-launcher-frontend` при изменениях React/TS/CSS.
- Admin web: `make build-admin-web`.
- Stardust mod: `make build-mod` только если менялся мод.
- Если изменились API-типы в `crates/protocol`, проверь Rust-пакеты и TypeScript-потребителей, которые ожидают JSON-поля.

Если проверка не запускалась, явно напиши почему.

## Git Workflow

- Перед коммитом проверь `git status --short` и `git diff`.
- В коммит добавляй только файлы текущей задачи.
- Сообщение коммита держи коротким и предметным, например `fix: track last server join time`.
- После коммита пушь ветку обычным `git push`, если пользователь попросил запушить.
- Не используй `git reset --hard`, `git checkout -- <file>` или force-push без прямого разрешения.

## Теги и релизы

- Теги `vX.Y.Z` запускают workflow `.github/workflows/launcher-release.yml` и собирают GitHub Release лаунчера.
- Ставь тег только когда пользователь просит релиз/тег или когда задача явно заканчивается выпуском лаунчера.
- Patch tag (`vX.Y.(Z+1)`) — багфиксы, небольшие UI/UX-правки, безопасные backend-исправления.
- Minor tag (`vX.(Y+1).0`) — новые пользовательские функции, заметные изменения UI/API, совместимые изменения поведения.
- Major tag (`v(X+1).0.0`) — breaking changes, несовместимые миграции/протоколы, ручные действия для пользователей.
- Предпочтительный способ: `sh scripts/release.sh` для patch, `sh scripts/release.sh minor`, `sh scripts/release.sh major` или `sh scripts/release.sh X.Y.Z`.
- Ручной способ: `git tag vX.Y.Z` и `git push origin vX.Y.Z`. Файлы версий руками не менять.
- Перед тегом убедись, что нужный коммит уже создан и находится на `HEAD`.

## Last Seen / Last Joined Semantics

- `lastJoinedAt` означает дату и время последнего подтверждённого захода игрока на Minecraft-сервер.
- Обновлять `lastJoinedAt` можно только после успешного Yggdrasil `hasJoined`, когда сервер подтвердил игрока.
- Нельзя обновлять `lastJoinedAt` при открытии лаунчера, логине в лаунчер, заходе в админку, нажатии `Играть` или ручном/фоновом sync статистики.
- Синхронизация Minecraft stats по SFTP обновляет только `playtimeSeconds`.

## Before Push Checklist

- `git status --short` показывает только ожидаемые изменения или чистое дерево после коммита.
- Все релевантные проверки пройдены.
- Миграции добавлены при изменении схемы БД.
- Frontend labels соответствуют текущей бизнес-логике.
- Если поставлен тег, он указывает на нужный коммит и запушен отдельно от ветки.
