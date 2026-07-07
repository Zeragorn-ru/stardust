# Minecraft Launcher & Server Platform

Приватная платформа для Minecraft-сервера: кастомный лаунчер, собственная
авторизация, доставка модпака, веб-админка и общий серверный/клиентский мод.

Репозиторий уже содержит рабочие сервисы, а не только каркас: лаунчер умеет
логинить игрока, синхронизировать сборку и запускать игру; `auth-server`
обслуживает как launcher API, так и Yggdrasil/sessionserver-эндпоинты;
`admin-server` и `admin-web` управляют сборками, аккаунтами и кастомизацией.

## Компоненты

| Путь | Что это | Стек |
| --- | --- | --- |
| `launcher/` | Десктоп-лаунчер: логин, 2FA, обновление сборки, запуск Minecraft, самообновление | Tauri 2, Rust, React, TypeScript |
| `crates/auth-server/` | Auth API + Yggdrasil/sessionserver + скины/плащи/статистика | Rust, Axum, PostgreSQL |
| `crates/admin-server/` | Admin API: сборки, файлы, аккаунты, бейджи, градиенты, SFTP-синхронизация | Rust, Axum, PostgreSQL |
| `admin-web/` | Веб-админка для сборок, аккаунтов и настроек инфраструктуры | React, TypeScript, Vite |
| `stardust-mod/` | Общий NeoForge-мод для клиента и сервера, интеграция с TAB и кастомизацией | Java 21, NeoForge |
| `crates/store/` | Общий storage-слой: аккаунты, сессии, сборки, challenge'ы, кастомизация | Rust, sqlx |
| `crates/protocol/` | Общие типы API и формата `manifest.json` | Rust, serde |
| `crates/telegram-bot/` | Telegram-бот для 2FA-кодов и системных уведомлений | Rust |
| `docs/` | Архитектура, дорожная карта, гайды по установке | Markdown |

## Что уже реализовано

1. **Лаунчер.**
   Есть реальные вход/регистрация, Telegram 2FA, вход без пароля, сброс пароля,
   сессия, профиль со скином/плащом, настройки, список опциональных модов,
   прогресс загрузок, самообновление и запуск Minecraft 1.21.1 через NeoForge.

2. **Авторизация и игровые сессии.**
   `auth-server` отдаёт `register/login/session/account`, загрузку и импорт
   скинов, статистику, crash-отчёты, а также Yggdrasil-совместимые
   `authenticate/refresh/validate/invalidate`, `join/hasJoined` и profile/textures.

3. **Модпак и доставка файлов.**
   `admin-server` хранит метаданные сборок в PostgreSQL, раздаёт публичный
   `GET /manifest` и `/files`, а лаунчер синхронизирует клиентские файлы по SHA-1,
   не затирая пользовательские конфиги с `overwrite: false`.

4. **Админка.**
   `admin-web` и `admin-server` уже покрывают логин администратора, CRUD сборок,
   загрузку файлов, активацию сборки, проверку зависимостей, управление
   аккаунтами, банами, ролями, Telegram-привязкой, бейджами и градиентами.

5. **Серверная кастомизация.**
   `stardust-mod` и `auth-server` уже умеют отдавать кастомизацию игроков для TAB:
   бейджи, цвет ника и градиенты.

Подробнее — в [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) и
[`docs/ROADMAP.md`](docs/ROADMAP.md).

## Сборка и CI

Корневой [`Makefile`](Makefile) — единая точка входа (`make help`):

```sh
make ci                  # проверки как в .github/workflows/ci.yml
make ci-launcher         # полная сборка лаунчера + dist/launcher-bundles/
make test-backend        # cargo test серверных крейтов
```

Rust **1.96** закреплён в [`rust-toolchain.toml`](rust-toolchain.toml). Подробности CI —
в [`.github/actions/README.md`](.github/actions/README.md) и [`AGENTS.md`](AGENTS.md).

| Workflow | Триггер | Назначение |
|----------|---------|------------|
| `ci.yml` | push/PR `master` | Быстрые проверки без релизов |
| `launcher-release.yml` | тег `v*` | Установщики → GitHub Releases |
| `launcher-build.yml` | `workflow_dispatch` | Отладочная сборка лаунчера |
| `backend.yml` | push `master` | Docker → ghcr.io + деплой |
| `mod-release.yml` | тег `mod-v*` | JAR мода → GitHub Releases |

Нативная упаковка (Arch, Fedora, Homebrew, Flatpak) — [`packaging/`](packaging/).

## Разработка

Backend и shared-код живут в Cargo workspace (см. корневой `Cargo.toml`).
Сейчас в воркспейсе: `protocol`, `store`, `auth-server`, `admin-server`,
`telegram-bot` и Tauri-бэкенд лаунчера (`launcher/src-tauri`).

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

### Запуск admin-server

```sh
ADMIN_BIND=127.0.0.1:8081 DATABASE_URL=postgres://... cargo run -p admin-server
```

По умолчанию публичный `files`-префикс строится как
`http://127.0.0.1:8081/files`. При необходимости можно переопределить через
`FILES_BASE_URL`.

### Сборка backend (Rust)

```sh
cargo build            # собрать весь воркспейс
cargo build -p auth-server
cargo build -p admin-server
cargo build -p protocol
```

### Запуск лаунчера (dev)

```sh
cd launcher
npm install            # один раз
npm run tauri dev      # запускает Vite + Tauri-окно
```

Для локальной разработки обычно нужны оба backend-сервиса:

```sh
cargo run -p auth-server
ADMIN_BIND=127.0.0.1:8081 DATABASE_URL=postgres://... cargo run -p admin-server
LAUNCHER_AUTH_URL=http://127.0.0.1:8080 LAUNCHER_ADMIN_URL=http://127.0.0.1:8081 npm run tauri dev
```

### Запуск admin-web

```sh
cd admin-web
npm install
npm run dev
```

Dev-сервер поднимается на `http://localhost:1430` и проксирует API на
`admin-server`.

### Самообновление лаунчера

Лаунчер сам опрашивает GitHub Releases API, сравнивает версию с текущей и при
наличии новой скачивает установщик NSIS (`*-setup.exe`) по HTTPS и запускает
его в тихом режиме (`/S`), без окон мастера установки. После установки NSIS
снова запускает уже обновлённый `StarDust.exe`. Поэтому при обычном обновлении
пользователь не может случайно выбрать полное удаление локальных данных.
Криптоподпись апдейтов не используется — безопасность обеспечивается
транспортом HTTPS GitHub. Эндпоинт по умолчанию задан в
`launcher/src-tauri/src/update.rs` (`RELEASES_API`), но его можно переопределить
переменной окружения (должна указывать на JSON одного релиза GitHub API):

```sh
LAUNCHER_UPDATE_URL=https://api.github.com/repos/OWNER/REPO/releases/latest npm run tauri dev
```

Проверка и установка доступны в настройках лаунчера (раздел «Обновления»).

### Установка на macOS

Скачайте **`StarDust_X.Y.Z_universal.dmg`** из [GitHub Releases](https://github.com/Zeragorn-ru/stardust/releases).

Полный гайд (Gatekeeper, первый запуск, обновления):

**[docs/MACOS_INSTALL.md](docs/MACOS_INSTALL.md)**

Кратко: откройте DMG → перетащите StarDust в **Applications** → при первом запуске
**ПКМ → Open** (лаунчер пока без платного Apple-сертификата). В DMG есть файл
**«Установка»** — он откроет гайд в браузере.

### Релиз новой версии лаунчера

Сборка лаунчера запускается **только по git-тегу вида `vX.Y.Z`**
(`.github/workflows/launcher-release.yml`). Просто запушить код в `master`
недостаточно — без тега установщики не соберутся и в Release ничего не
попадёт.

**Источник правды версии — git-тег.** В исходниках версия хранится как
плейсхолдер `0.0.0` (в `launcher/package.json`,
`launcher/src-tauri/Cargo.toml`, `launcher/src-tauri/tauri.conf.json` и
`Cargo.lock`). На пуш тега workflow сам подставляет реальную версию (тег без
префикса `v`) во все эти файлы перед сборкой. Руками версию править не нужно.

Проще всего выпускать релиз скриптом — он берёт последний тег, считает
следующий и пушит новый:

```sh
sh scripts/release.sh            # патч-бамп:  v0.2.9 -> v0.2.10
sh scripts/release.sh minor      # минор:      v0.2.9 -> v0.3.0
sh scripts/release.sh major      # мажор:      v0.2.9 -> v1.0.0
sh scripts/release.sh 0.3.0      # явная версия -> тег v0.3.0
sh scripts/release.sh --dry-run  # показать вычисленный тег, ничего не делая
sh scripts/release.sh --no-push  # создать тег локально, без пуша
```

Либо вручную — достаточно поставить и запушить тег (файлы трогать не надо):

```sh
git tag v0.2.10
git push origin v0.2.10
```

Дальше workflow `launcher-release` создаст GitHub Release `v0.2.10` и соберёт
установщики для **Windows** (NSIS `.exe`), **Linux** (`.deb`, `.rpm`, AppImage) и
**macOS** (universal `.dmg` с гайдом по установке). Установленные лаунчеры
подхватят обновление через GitHub Releases API.

Сборка не требует ключей подписи Apple — без сертификата macOS-сборка идёт
unsigned (см. [гайд по установке](docs/MACOS_INSTALL.md)). Релизный workflow
собирает установщики и прикладывает их к GitHub Release:

```sh
cd launcher
npm run tauri build
```

> При ручной деинсталляции (Windows/NSIS) лаунчер спросит, удалять ли данные из
> `%APPDATA%\com.project.launcher` (Java, клиент, NeoForge, ассеты, настройки).
> По умолчанию данные сохраняются. При автообновлении установщик запускается
> тихо, выбор удаления данных не показывается, а после установки лаунчер
> открывается обратно.

## Текущее состояние

Проект уже рабочий как внутренний контур платформы, но остаются заметные зоны
развития: безопасность хранения локальной сессии, покрытие тестами фронтенда,
инфраструктурная сборка и полировка серверной интеграции вокруг мода.
