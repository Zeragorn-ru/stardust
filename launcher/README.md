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

## Адрес admin-сервиса (сборки/модпак)

Перед запуском игры лаунчер тянет манифест активной сборки с admin-сервиса
(`GET /manifest`) и раскладывает клиентские файлы (моды, конфиги, ресурсы) в
игровой каталог. Базовый URL берётся из `LAUNCHER_ADMIN_URL`; по умолчанию —
прод-адрес `https://admin.zeragorn.xyz`.

```sh
# локальная разработка против своего admin-server (через admin-web)
LAUNCHER_ADMIN_URL=http://127.0.0.1:8082 npm run tauri dev
```

Синхронизация идёт по SHA-1: актуальные файлы не перекачиваются, а
пользовательские правки конфигов (`overwrite: false`) не затираются. Лаунчер
ведёт реестр поставленных файлов (`managed-files.json` в игровом каталоге),
чтобы убирать моды, удалённые из сборки. Если активной сборки нет, игра
запускается без модпака.

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
- `bundle/msi/StarDust_<версия>_x64_en-US.msi` — MSI-установщик
- `bundle/nsis/StarDust_<версия>_x64-setup.exe` — NSIS-установщик

## Linux

CI собирает Linux-артефакты на `ubuntu-22.04` (webkit2gtk 4.1 стабилен именно
там; на 24.04 у Tauri бывает пустое окно webview). На выходе три формата:

- `bundle/deb/StarDust_<версия>_amd64.deb` — для **Debian / Ubuntu / Mint** и
  прочих apt-дистрибутивов.
- `bundle/rpm/StarDust-<версия>.x86_64.rpm` — для **Fedora / openSUSE / RHEL**.
- `bundle/appimage/StarDust_<версия>_amd64.AppImage` — универсальный бинарник,
  работает без установки на большинстве дистрибутивов, включая **Arch / Manjaro**
  (нативного `pacman`-пакета Tauri не делает, AppImage — штатный путь для Arch).

### Системные зависимости для сборки из исходников

Имена пакетов различаются по дистрибутивам:

```sh
# Debian / Ubuntu
sudo apt-get install libwebkit2gtk-4.1-dev libappindicator3-dev librsvg2-dev patchelf libgtk-3-dev

# Arch / Manjaro
sudo pacman -S webkit2gtk-4.1 gtk3 libappindicator-gtk3 librsvg patchelf
```

### NixOS

AppImage на NixOS из коробки не запускается (нет FHS-путей к загрузчику и
`/lib`), поэтому для Nix в корне репозитория есть `flake.nix` — сборка идёт
герметично из исходников.

```sh
# среда разработки (все нативные либы webkit2gtk и пр. подтягиваются автоматически)
nix develop
cd launcher && npm install && npm run tauri dev

# сборка/запуск пакета
nix build .#launcher
nix run  .#launcher
```

Примечание: при первой сборке пакета (`nix build`) Nix сообщит ожидаемый хэш
npm-зависимостей — его нужно один раз подставить в `flake.nix` вместо
`pkgs.lib.fakeHash` (поле `npmDeps.hash`). Dev-shell (`nix develop`) работает
без этого шага.
