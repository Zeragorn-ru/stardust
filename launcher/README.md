# Stardust Launcher

Десктопный лаунчер Stardust на Tauri 2, React и Rust. Он авторизует игрока, синхронизирует curated-сборку, подготавливает runtime и запускает Minecraft 1.21.1 через NeoForge.

## Возможности

- onboarding, регистрация, логин, автологин и logout;
- Telegram 2FA, passwordless-вход и сброс пароля;
- bearer token в системном keyring;
- offline/degraded mode для сохраненной локальной сессии;
- скачивание Java 21, Minecraft client, libraries, assets и natives;
- запуск через authlib-injector, `-XstartOnFirstThread` на macOS и защита от второй копии;
- manifest sync по SHA-1 с parallel downloads, progress, speed, ETA и retry;
- optional mods с `.dis`, выбором игрока и конфликтами;
- `overwrite: false` для пользовательских конфигов и реестр managed files;
- настройки JVM memory, proxy, Java path/provider, download concurrency и data directory;
- загрузка/импорт скинов, classic/slim, плащ и 3D preview;
- launcher/Minecraft/crash logs и отправка crash telemetry;
- самообновление Windows/macOS/Linux через GitHub Releases.

## Структура

```text
launcher/
├── src/                    # React UI
│   ├── App.tsx             # переходы между экранами и lifecycle
│   ├── api.ts              # Tauri commands и browser fallbacks
│   ├── types.ts            # типы UI
│   └── components/         # login, main, settings, mods, logs, skins, update
└── src-tauri/              # Rust backend
    └── src/
        ├── commands.rs     # Tauri commands и auth/session flows
        ├── minecraft.rs    # Java/Minecraft/NeoForge runtime
        ├── modpack.rs      # manifest sync и managed files
        ├── update.rs       # launcher updater
        ├── backend.rs      # HTTP API client
        ├── game_guard.rs   # single-instance и game lifecycle
        └── paths.rs        # data directory и portable mode
```

## Сервисы

Auth API задается через `LAUNCHER_AUTH_URL` и по умолчанию указывает на production auth-server. Manifest и файлы сборки берутся из `LAUNCHER_ADMIN_URL`.

```sh
LAUNCHER_AUTH_URL=http://127.0.0.1:8080 \
LAUNCHER_ADMIN_URL=http://127.0.0.1:8081 \
npm run tauri dev
```

Если активная сборка отсутствует, launcher может запустить игру без modpack. Для обычного запуска нужны доступные auth-server и admin-server.

## Локальные данные

В установленном режиме данные хранятся в системной application data directory. На macOS это `~/Library/Application Support/com.stardust.launcher/`. В portable-режиме при наличии `portable.txt` или `.portable` рядом с executable используется `data/` рядом с ним.

В data directory находятся настройки, профиль для offline/degraded режима, выбор optional-модов, логи и служебное состояние. Bearer token хранится в OS keyring, а не в открытом JSON-файле.

Игровой каталог дополнительно содержит `managed-files.json`, который позволяет удалять устаревшие файлы сборки только если игрок не изменял их вручную.

## Разработка

Из корня репозитория:

```sh
make launcher-deps
make dev-launcher
```

Или напрямую:

```sh
cd launcher
npm ci
npm run tauri dev
```

Только React в браузере:

```sh
cd launcher
npm run dev
```

Проверки:

```sh
make build-launcher-frontend
make clippy-launcher
make build-launcher
```

## Сборка и релизы

```sh
cd launcher
npm run tauri build
```

Для CI и полной локальной проверки используется `make ci-launcher`. Релизные установщики собираются workflow `launcher-release.yml` по git-тегу `vX.Y.Z`; исходники лаунчера намеренно содержат версию `0.0.0`.

Поддерживаемые release artifacts: Windows NSIS/MSI, Linux DEB/RPM/AppImage и universal macOS DMG. macOS-артефакт может быть unsigned; инструкция первого запуска находится в [`../docs/MACOS_INSTALL.md`](../docs/MACOS_INSTALL.md).

Подробная общая roadmap: [`../docs/ROADMAP.md`](../docs/ROADMAP.md).
