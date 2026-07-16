# Roadmap

Документ отражает текущее состояние репозитория и ближайшие задачи. Здесь нет
исторических шагов «как начинали»; только то, что уже сделано, и то, что ещё
имеет смысл добивать.

## Vision

**Stardust Launcher** — десктопный лаунчер одной кураторской сборки и одного
сервера. Ощущение: **Modrinth App + Prism Launcher**, но проще и цельнее — без
мульти-инстансов, без браузера модов, с интеграцией auth/скин/ban/playtime из
коробки.

## Goals

- Запуск «Играть → sync → Minecraft» без сюрпризов на macOS / Windows / Linux
- Curated optional mods с конфликтами (DH ↔ Voxy) и категориями
- Нативный desktop UX: title bar, shortcuts, скролл, честный progress
- Безопасность auth/2FA/sessions на уровне production
- Админка для сборки без ручного SFTP-хаоса

## Non-goals

- Универсальный менеджер инстансов (как Prism для десятков профилей)
- Встроенный CurseForge/Modrinth browser и произвольная установка модов
- Поддержка нескольких независимых серверов/сборок в одном лаунчере
- Редактор модов, скриптинг, плагины лаунчера
- Замена полноценного server panel (только sync + manifest + ops API)

## Приоритеты (P0 / P1 / P2)

### P0 — блокеры и доверие

| Область | Задача |
|---------|--------|
| Auth | Yggdrasil authenticate не обходит Telegram 2FA; rate limits |
| Store | Session tokens только SHA-256 в БД (`create_session`) |
| Admin | Закрыть `/api/build-check`, `/api/deps-check` без auth |
| Launch | `-Xms` ≠ `-Xmx`; default RAM не 16 GB |
| Update | macOS `get_install_dir` → `.app`, обязательный SHA-256 |
| UX | Скролл настроек/модов; Java progress не блокирует Play |
| macOS | Native Overlay title bar, Cmd+W, Escape не убивает окно над модалками |

*Часть P0 UX (macOS bar, scroll, conflicts UI) — в незакоммиченных изменениях ветки `integrate/launcher-patches`.*

### P1 — «Modrinth + Prism для одной сборки»

- Mod cards + категории optional mods (оптимизация / визуал / QoL)
- `conflictsWith` в admin UI и manifest
- Platform matrix для **лаунчера и игры** (см. ниже)
- Rename не сбрасывает ban; `PlayerProfile` camelCase
- Prism-style launch log + retry на экране Play
- Рекомендации optional mods: [`modpack-optional-mods.md`](modpack-optional-mods.md)

### P2 — полировка

- FancyMenu / Drippy / Seamless loading в curated optional
- Fusion CTM вместо Continuity на чистом NeoForge
- Mod cards с иконками из jar; bulk enable «performance pack»
- In-game keybind presets per platform в доке + дефолтный resource pack hints

## Platform matrix: кейбинды

### Лаунчер (Tauri / WebView)

| Действие | macOS | Windows / Linux |
|----------|-------|-----------------|
| Закрыть окно | Cmd+W | Alt+F4 / Ctrl+W (по желанию) |
| Назад из настроек | Escape | Escape |
| Закрыть модалку | Escape (не закрывает окно) | Escape |
| Quit | Cmd+Q (native menu) | Alt+F4 |

### Minecraft / моды (боль игроков)

| Проблема | macOS | Win/Linux |
|----------|-------|-----------|
| «Ctrl» в подсказках модов | Часто нужен **Cmd** (GLFW) | Ctrl |
| Fullscreen / F3 debug | Fn+F3, Option+клик | F3 |
| Inventar / drop | Q без conflicts | Q |
| Sodium/Iris меню | Зависит от binding; не пересекать с OS | Аналогично |
| Modrinth «Controlling» | Искать по **Cmd** | Ctrl |

**План:** документ `docs/KEYBINDS.md` + optional mod **Controlling** + в лаунчере
ссылка «Кейбинды на Mac»; для сборки — не включать DH и Voxy одновременно;
проверять conflicts в ModsSection.

## Метрики успеха

- Первый запуск → Play без рестарта devtools / лаунчера
- macOS: нативные traffic lights, без кастомного «Windows title bar»
- 0 critical из P0 security после релиза
- Optional mods: видны конфликты до запуска игры
- Время до «Minecraft main menu» не регрессирует после UX-правок

## Уже сделано

### 1. Базовая платформа
- [x] Монорепозиторий с Cargo workspace и отдельными frontend-пакетами
- [x] Общие crates `protocol` и `store`
- [x] PostgreSQL-хранилище для аккаунтов, сессий, сборок и кастомизации

### 2. Лаунчер
- [x] Tauri + React интерфейс
- [x] Логин и регистрация
- [x] Telegram 2FA
- [x] Вход без пароля через Telegram
- [x] Сброс пароля через Telegram-код
- [x] Автологин и восстановление локальной сессии
- [x] Хранение токена сессии в системном keyring вместо `session.json`
- [x] Экран профиля, скин, плащ, статистика
- [x] Настройки памяти, параллельности загрузок, прокси и UI-поведения
- [x] Список опциональных модов
- [x] Прогресс, скорость, ETA, ошибки и повтор при обновлении лаунчера
- [x] Самообновление лаунчера через GitHub Releases

### 3. Запуск игры и модпак
- [x] Подготовка vanilla Minecraft 1.21.1
- [x] Загрузка Java 21 для Windows и использование системной Java на Linux
- [x] Установка и запуск NeoForge
- [x] Синхронизация модпака по `manifest.json` и SHA-1
- [x] Поддержка `overwrite: false` для пользовательских конфигов
- [x] Учёт управляемых файлов и удаление лишнего
- [x] Подключение `authlib-injector`
- [x] Отправка игровой статистики и crash-отчётов на backend

### 4. Auth-сервер
- [x] Регистрация и логин
- [x] Сессии и `/api/session`
- [x] Смена ника, пароля и удаление аккаунта
- [x] Telegram-привязка
- [x] Импорт и загрузка скинов
- [x] Выдача плаща и профиля игрока
- [x] Yggdrasil `authenticate/refresh/validate/invalidate`
- [x] Yggdrasil `join/hasJoined/profile`
- [x] `server_customization` для серверного мода
- [x] Сбор и выдача статистики игрока

### 5. Admin API и web-админка
- [x] Логин администратора
- [x] CRUD сборок
- [x] Загрузка и редактирование файлов сборки
- [x] Активация и клонирование сборок
- [x] Публичный `/manifest` и `/files`
- [x] Проверка целостности сборки (`build-check`)
- [x] Проверка зависимостей модов (`deps-check`)
- [x] Управление аккаунтами, ролями и банами
- [x] Управление бейджами и градиентами
- [x] Настройки Telegram и SFTP
- [x] SFTP-синхронизация на внешнюю панель
- [x] Загрузка и деплой общего мода

### 6. Общий мод
- [x] Один jar для клиента и сервера
- [x] Интеграция с TAB
- [x] Подавление стандартных join/leave-сообщений
- [x] HTTP-получение кастомизации игроков с backend

## Ближайшие задачи

### 1. Безопасность
- [x] Перестать записывать bearer-токен в `session.json`; хранить его только в keyring
- [ ] Убрать жёстко прошитый builtin-прокси из обновлятора; настройки прокси уже используются, но fallback-адрес всё ещё встроен
- [ ] Довести хеширование паролей до полноценного Argon2 для новых записей, а не только fallback-проверки
- [ ] Расширить rate limiting на все критичные endpoints и задокументировать лимиты; текущий лимитер покрывает только отдельные сценарии

### 2. Качество и тесты
- [x] Добавить CI smoke-проверки сборки для `launcher` и `admin-web`
- [ ] Добавить frontend-тесты для пользовательских сценариев `launcher` и `admin-web`; сейчас в npm-пакетах есть только `build`
- [ ] Добавить интеграционные тесты для `auth-server` и `admin-server`
- [ ] Проверять end-to-end сценарий: логин -> sync modpack -> launch -> report stats
- [ ] Добавить contract-тесты для JSON API между `crates/protocol`, launcher, admin-web и серверными endpoints

### 3. UX/UI и QoL
- [ ] Добавить единый центр уведомлений в launcher и admin-web: история операций, повтор действия, копирование ошибки и ссылка на логи
- [ ] Добавить глобальный быстрый поиск/command palette в admin-web для перехода к сборкам, игрокам, настройкам и частым операциям
- [ ] Улучшить onboarding лаунчера: чек-лист первого запуска, проверка Java/диска/доступа к backend и понятные подсказки до кнопки «Играть»
- [ ] Добавить подсказки и inline-help для сложных настроек: прокси, память, optional mods, Telegram, SFTP, authlib-injector и deploy общего мода
- [ ] Добавить сохранение UI-предпочтений: фильтры и сортировка таблицы аккаунтов уже сохраняются; остались последняя вкладка настроек, фильтры модов, выбранная сборка и плотность интерфейса
- [ ] Добавить skeleton/empty/error states для всех долгих списков и карточек: health-блок сайта и warning при частичной ошибке статистики аккаунтов уже добавлены; остались расширенные states для сборок и файлов в admin-web
- [ ] Улучшить админский файловый менеджер: retry только упавших загрузок, summary очереди и остановка после текущего файла уже добавлены; остались расширенный batch edit метаданных, true-cancel активного XHR и preview массовых операций
- [ ] Добавить drag-and-drop reorder/preview для файлов сборки там, где порядок влияет на UX или диагностику; минимум — визуальные превью и сравнение перед публикацией
- [ ] Расширить таблицу аккаунтов: сортировка и фильтры по роли/бану/Telegram/активности уже добавлены; остались пагинация или виртуализация при большом числе игроков
- [ ] Добавить bulk-actions для аккаунтов и сборок с безопасным preview перед применением
- [ ] Добавить copy-to-clipboard действия: UUID игроков, пути файлов, SHA-1, ссылки на manifest/files и server address уже копируются; остались diagnostic IDs
- [ ] Улучшить доступность: skip-link, aria-live для website статусов и возврат фокуса из map dialog уже добавлены; остались полная клавиатурная навигация по модалкам, focus trap, проверка контраста и reduced-motion для новых эффектов
- [ ] Унифицировать дизайн-систему между launcher, admin-web и website: токены цветов/отступов/радиусов, состояния кнопок, форм, toast и modal
- [ ] Добавить browser-based визуальные smoke-тесты ключевых экранов на desktop/tablet/mobile breakpoints
- [ ] Улучшить публичный сайт QoL: автоопределение платформы скачивания, прямые ссылки на latest assets, более прямой download flow, вынос карты из основного сценария, копирование адреса и fallback-карточка статуса уже добавлены; остались более точный онлайн Minecraft-сервера и проверка fallback-сценариев на production-конфиге
- [ ] Провести полный UX/UI review публичного сайта `website`: first iteration упростила hero, навигацию, стартовый download flow, статус перед стартом и accessibility основы, а отдельный map-блок и лишние map-styles убраны из main flow; дальше нужен аудит mobile/tablet breakpoints, скорости восприятия, визуальной иерархии, trust-блоков и production fallback

### 4. CI/CD и релизы
- [ ] Починить ручной выбор платформы в `launcher-release.yml` и `launcher-build.yml`: input `platform` есть, но matrix сейчас всё равно запускает все платформы
- [ ] Разнести сборку лаунчера и публикацию GitHub Release, чтобы matrix jobs не создавали и не изменяли один release параллельно
- [ ] Добавить `concurrency` для release/deploy workflow, чтобы параллельные запуски не перетирали релизы и production-контур
- [ ] Добавить `deploy/docker-compose.yml` в path-фильтр backend workflow, иначе изменение compose не запускает деплой
- [ ] Сузить permissions и область действия release tokens: сейчас release jobs получают `contents: write` и токены на уровне всего job
- [ ] Валидировать ручные версии и release tags до shell-скриптов в launcher/mod workflows
- [ ] Закрепить сторонние GitHub Actions по commit SHA или ввести регулярный аудит обновлений
- [ ] Убрать изменение macOS `.app` после подписания или добавить повторную подпись и `codesign --verify --deep --strict`
- [ ] Добавить Gradle cache и проверку wrapper для сборки мода

### 5. Лаунчер
- [ ] Доработать оффлайн-режим и явно отделить его UX от «сервер временно недоступен»
- [x] Полировать UX обновлений и статусов скачивания: прогресс, скорость, ETA, ошибки и повтор
- [ ] Расширить настройки runtime и диагностику проблем запуска
- [ ] Добавить восстановление после частично скачанного/повреждённого модпака: resume, quarantine битых файлов и понятный repair-flow

### 6. Серверная интеграция и эксплуатация
- [ ] Довести compose/nix/scripts до развёртывания полного контура; базовый Compose и скрипт обновления уже есть
- [ ] Описать production-схему reverse proxy, TLS и доменов; архитектурная схема есть, практического гайда нет
- [ ] Описать production-сценарий кастомизации и скинов; кодовый поток уже работает
- [ ] Перевести деплой с `docker compose down` на rolling/zero-downtime стратегию хотя бы для stateless-сервисов
- [ ] Убрать запуск production-деплоя от root и описать минимальные права пользователя деплоя
- [ ] Добавить healthcheck для `auth-server`, `admin-server`, web-контейнеров и squid в compose, а не только для PostgreSQL
- [ ] Добавить backup/restore runbook для PostgreSQL, ключа Yggdrasil, модпака, скинов и настроек
- [ ] Добавить метрики и алерты: latency/error rate endpoints, очередь Telegram, SFTP sync, размер/ошибки modpack-хранилища
- [ ] Ограничить CORS в production по умолчанию и явно документировать допустимые origins

### 7. Мод и кастомизация
- [ ] Расширить runtime-интеграцию мода beyond TAB; уже есть обработка join/leave и challenge-логика
- [ ] Добавить полноценные админские инструменты диагностики кастомизации; debug-логи и `/stardust refresh` уже есть

### 8. Зависимости и supply chain
- [ ] Добавить Dependabot/Renovate для Cargo, npm, Gradle, Docker images и GitHub Actions
- [ ] Добавить SBOM и checksum/signature publication для launcher, mod jar и Docker images
- [ ] Заменить плавающие Docker tags (`latest`, `ubuntu/squid:latest`) на pinning по версии или digest с регламентом обновления
