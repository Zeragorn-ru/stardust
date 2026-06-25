# Лаунчер (Tauri + React)

Десктоп-лаунчер: вход на auth-сервере, обновление сборки и запуск Minecraft.

## Стек

- **Tauri 2** — нативная оболочка (Rust), кроссплатформа Windows/Linux
- **React + TypeScript + Vite** — интерфейс
- общий crate `crates/protocol` — типы манифеста и профиля

## Структура

```
launcher/
├── index.html
├── package.json            # фронтенд (Vite/React)
├── vite.config.ts
├── tsconfig.json
├── src/                    # React UI
│   ├── main.tsx            # точка входа
│   ├── App.tsx             # роутинг экранов
│   ├── api.ts              # обёртка над Tauri-командами (+ фолбэки для браузера)
│   ├── types.ts            # типы UI
│   ├── styles.css
│   └── components/
│       ├── LoginScreen.tsx
│       ├── MainScreen.tsx
│       └── SettingsScreen.tsx
└── src-tauri/              # Rust-бэкенд
    ├── Cargo.toml
    ├── tauri.conf.json
    ├── build.rs
    ├── capabilities/default.json
    └── src/
        ├── main.rs
        ├── lib.rs
        ├── paths.rs        # режим запуска (portable/installed) и пути данных
        ├── backend.rs      # HTTP-клиент к auth-серверу
        └── commands.rs     # команды (login/register/settings/skin/play)
```

## Текущее состояние

Интерфейс готов; бэкенд подключён к **auth-серверу** по HTTP:

- `login` / `register` — реальные запросы на `/api/login` и `/api/register`,
  UUID выдаёт сервер; ошибки сервера (`{error}`) показываются пользователю
- настройки пишутся в папку данных (см. «Папка данных»)
- скин хранится на auth-сервере и привязан к аккаунту; загрузка скина требует
  активную сессию владельца
- сессия сохраняется в `session.json`; при старте лаунчер проверяет токен на
  `/api/session` и автоматически возвращает игрока в аккаунт
- `play_game` — пока проверяет только наличие сессии (запуск игры будет позже)

Реальная логика подключается по шагам — см. `../docs/ROADMAP.md`.

## Адрес auth-сервера

Базовый URL берётся из переменной окружения `LAUNCHER_AUTH_URL`.
Если она не задана, используется прод-адрес `https://auth.zeragorn.xyz`
(значение по умолчанию, зашитое в сборку).

```sh
# локальная разработка против своего сервера
LAUNCHER_AUTH_URL=http://127.0.0.1:8080 npm run tauri dev
```

Запросы к серверу идут из Rust (`reqwest`), а не из webview, поэтому CORS/CSP
окна на них не влияют.

## Папка данных

Лаунчер сам решает, куда писать локальные настройки, по наличию маркера рядом с exe:

- **Портативный режим** — если рядом с `launcher.exe` лежит `portable.txt`
  (или `.portable`). Тогда всё хранится в `data/` рядом с exe — ничего не
  пишется в систему, папку можно носить с собой.
- **Установленный режим** — маркера нет. Данные идут в системную папку
  `%APPDATA%\com.project.launcher` (Windows).

Внутри папки данных сейчас:

- `settings.json` — локальные настройки лаунчера
- `session.json` — сохранённый профиль и bearer-токен для автологина

Скины не лежат на клиенте: они берутся с auth-сервера по UUID текущего аккаунта.

## Запуск (dev)

Нужны Node.js и Rust-тулчейн, а также системные зависимости Tauri
(WebView2 на Windows; webkit2gtk и пр. на Linux).

```sh
cd launcher
npm install
npm run tauri dev
```

Можно поднять только фронтенд в браузере (без нативного окна) — тогда
сработают dev-фолбэки из `src/api.ts`:

```sh
npm run dev
```

## Сборка релиза

```sh
cd launcher
npm run tauri build
```

Результат (в `../target/release/`):

- `launcher.exe` — самостоятельный исполняемый файл (для портативного режима:
  положите рядом `portable.txt`)
- `bundle/msi/Project Launcher_<версия>_x64_en-US.msi` — MSI-установщик
- `bundle/nsis/Project Launcher_<версия>_x64-setup.exe` — NSIS-установщик
