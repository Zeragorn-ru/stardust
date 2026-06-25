# Архитектура

## Обзор

```mermaid
graph TD
    subgraph Игрок
        LAUNCH[Лаунчер Tauri]
        GAME[Minecraft + authlib-injector]
    end

    subgraph "Сервер (Docker Compose)"
        PROXY[reverse-proxy / nginx + TLS]
        AUTH[auth-server / Rust]
        API[admin / Rust]
        WEB[admin-web / React]
        FILES[file-server / nginx]
        MC[mc-server + authlib-injector]
        DB[(PostgreSQL)]
        VOL[(modpack-data volume)]
        WORLD[(world volume)]
    end

    LAUNCH -->|логин/пароль| PROXY --> AUTH
    LAUNCH -->|manifest + файлы| PROXY --> FILES
    LAUNCH -->|запускает| GAME
    GAME -->|joinServer / hasJoined| PROXY
    MC -->|hasJoined| AUTH

    WEB --> PROXY --> API
    API --> DB
    AUTH --> DB
    API -->|пишет моды/конфиги| VOL
    VOL --> FILES
    VOL -->|server+both| MC
    MC --> WORLD
```

## Поток авторизации (Yggdrasil + authlib-injector)

Сервер остаётся в `online-mode=true`. authlib-injector подменяет зашитые
URL Mojang на наш `auth-server` — и на клиенте (через лаунчер), и на сервере
(через `-javaagent`).

```mermaid
sequenceDiagram
    participant L as Лаунчер
    participant A as auth-server
    participant C as Клиент игры
    participant S as MC-сервер

    L->>A: POST /authserver/authenticate (login, password)
    A-->>L: accessToken + selectedProfile (UUID, name)
    L->>C: запуск игры с токеном + javaagent
    C->>S: подключение, отправка профиля
    S->>C: запрос шифрования + serverId
    C->>A: POST /sessionserver/.../join (accessToken, serverId)
    A-->>C: 204 No Content
    C->>S: продолжает подключение
    S->>A: GET /sessionserver/.../hasJoined?username=&serverId=
    A-->>S: 200 + профиль (UUID, текстуры)
    Note over S: игрок впущен
```

## Модель сборки (modpack)

Каждый файл сборки имеет:

- `path` — путь относительно `.minecraft` (напр. `mods/sodium.jar`)
- `side` — `client` | `server` | `both`
- `kind` — `mod` | `config` | `resource` | `other`
- `sha1`, `size`
- `overwrite` — затирать ли локальную версию (для конфигов часто `false`)

**Клиентский манифест** содержит файлы со `side ∈ {client, both}`.
**Серверная папка** — файлы со `side ∈ {server, both}`.

Формат манифеста определён в общем crate `crates/protocol`.

## Процесс обновления (лаунчер)

```mermaid
graph TD
    A[Скачать manifest.json] --> B{Для каждого файла}
    B --> C{SHA-1 совпадает?}
    C -->|да| B
    C -->|нет| D[Скачать файл]
    D --> E[Проверить SHA-1]
    E --> B
    B -->|конец| F[Удалить лишние моды<br/>не из манифеста]
    F --> G[Скачать/проверить JRE]
    G --> H[Собрать команду JVM]
    H --> I[Запустить игру]
```

## Statefulness (Docker volumes)

| Volume          | Содержимое                       | Кто пишет | Кто читает         |
| --------------- | -------------------------------- | --------- | ------------------ |
| `pgdata`        | БД PostgreSQL                    | postgres  | postgres           |
| `modpack-data`  | моды, конфиги, манифест          | admin     | file-server, mc    |
| `world`         | мир Minecraft                    | mc        | mc                 |

Контейнеры эфемерны; всё состояние — в volumes.
