# Roadmap

Этот документ описывает фактическое состояние Stardust на 30 июля 2026 года и следующие инженерные приоритеты. Список составлен по текущему коду, миграциям, API и интерфейсам; старые исторические планы сюда не переносятся.

## Направление

Stardust — управляемая платформа для curated Minecraft-сборки и сервера. Приоритет продукта — не каталог модов и не универсальный менеджер десятков инстансов, а надежный путь:

```text
аккаунт -> проверка окружения -> синхронизация сборки -> Minecraft -> статистика и поддержка
```

## Уже работает

### Launcher

- Tauri 2 + React/TypeScript UI;
- onboarding, login/register, persistent session, logout;
- Telegram 2FA, passwordless authentication и password reset;
- bearer token в OS keyring;
- offline/degraded запуск с локальным профилем и queued statistics;
- Minecraft 1.21.1 + NeoForge;
- Java 21 download/autodetect, assets, libraries, natives, authlib-injector;
- защита от второй копии и восстановление незавершенной игровой сессии;
- manifest sync с параллельными загрузками, SHA-1, progress, speed, ETA и retry;
- managed files, `overwrite: false`, optional mods и `.dis`;
- manifest/static conflicts для optional mods;
- память JVM, proxy, Java provider/path, concurrency и перенос data directory;
- скины, плащи, classic/slim и 3D viewer;
- launcher update для Windows/macOS/Linux через GitHub Releases;
- launcher/Minecraft/crash logs и crash telemetry.

### Backend

- `protocol`: DTO API, `Manifest`, loader/side/kind и optional metadata;
- `store`: PostgreSQL migrations, accounts, sessions, builds, news, customization, Telegram outbox, playtime and telemetry;
- `auth-server`: launcher API, Yggdrasil/sessionserver, profile/textures, skins, stats, bans, news and crash reports;
- `admin-server`: accounts, builds, file storage, build/deps checks, SFTP deploy, settings and telemetry;
- `telegram-bot`: 2FA, admin notifications and queued documents.

### Admin web

- desktop и отдельный mobile entrypoint;
- accounts: search, filters, roles, bans, password, Telegram binding, skin and cosmetics;
- builds: CRUD, clone, activation, file manager, upload, text editor and checks;
- news, customization and infrastructure settings;
- SFTP deployment with progress;
- server overview with online, TPS, MSPT, join/quit and logs.

### Stardust mod

- единый NeoForge client/server JAR;
- TAB placeholders, badges, name colors and gradients;
- server chat, join/quit and private messages;
- auth-server customization lookup with cache/fallback;
- server telemetry using Spark or local measurement;
- super-challenge health bonus;
- client/server crash markers and BACAP-related resources.

## P0: надежность и безопасность

1. **Repair Installation.** Проверка manifest, докачка поврежденных файлов, quarantine битых файлов, исправление `.dis`, resume и безопасное сохранение user-owned данных.
2. **Atomic update state.** Staging directory, lock/operation state и восстановление после убийства лаунчера или отключения питания.
3. **Release rollback.** Хранить предыдущую рабочую сборку, показывать diff перед обновлением и возвращать ее одним действием.
4. **Session lifecycle.** TTL, отзыв отдельных сессий, «выйти со всех устройств» и список активных устройств.
5. **Admin Telegram confirmation.** Вход в админку должен требовать подтверждение через Telegram после проверки логина и пароля; challenge должен быть одноразовым, иметь срок действия и быть привязан к сессии/устройству.
6. **Audit log.** Кто и когда изменил аккаунт, бан, роль, косметику, сборку, файл, новость или запустил deploy.
7. **Supply-chain checks.** Сделать checksum обязательным для updater и перейти с SHA-1 на SHA-256/SHA-512 для новых manifest entries.
8. **Input validation.** Декодировать и проверять размеры skin PNG, ограничить размер и усилить проверки загружаемых файлов.

## P1: release operations

1. **Channels:** `stable`, `beta`, `nightly`, доступ по invite-коду и staged rollout.
2. **Manifest v2:** dependencies, conflicts, loader constraints, changelog, release metadata и более сильные хэши.
3. **Release console:** preview diff, validation, activation, mandatory update, rollback и история деплоев.
4. **Crash grouping:** группировать падения по stack trace, mod, Java, OS, launcher/build version вместо отдельных Telegram-сообщений.
5. **Детали событий в админских логах:** открытие записи по клику с полной информацией, metadata, stack trace, версией сборки, игроком, окружением и связанными событиями.
6. **Crash log bundle:** из карточки вылета скачивать архив всех связанных файлов: `latest.log`, crash report, launcher log, debug log, список модов, manifest и диагностические metadata.
7. **Per-mod allowlist по хэшу:** для сторонних модов из crash/launch telemetry добавлять конкретный hash в разрешенные отдельно для каждого мода; разрешенные версии не должны отправлять Telegram-уведомления, но остаются видимыми в админке и статистике.
8. **Release health:** launch success, crash-free sessions, download failures, repair rate и server join success по версии сборки.
9. **Support bundle:** logs, crash reports, manifest, runtime info, hashes и operation ID одним архивом без пользовательских миров и приватных данных.
10. **Maintenance mode:** закрытие новых входов на сервер с объяснением в лаунчере, Telegram и админке.

## P1: модель платформы

1. **Loader honesty or support.** Либо ограничить protocol/admin реальным NeoForge runtime, либо добавить отдельные installers и launch arguments для Vanilla/Fabric/Quilt/Forge.
2. **Multi-server model.** Добавить `server_id` в telemetry, logs, manifests, SFTP targets и launcher server selection.
3. **Server health.** Health checks для auth, admin, Telegram, SFTP, file storage и Minecraft connectivity.
4. **Retention and storage.** Retention для telemetry/logs и безопасный garbage collection orphaned content-addressed blobs.
5. **Telemetry correctness.** Средние значения должны считаться за выбранное окно, а не по всей истории; join/quit должны быть разделены по серверу.
6. **Security boundaries.** Защитить server customization signed server token-ом или ограниченным batch endpoint-ом; включить host-key verification во всех SFTP flows.

## P2: удобство игрока

1. **Update preview:** список изменений, место на диске, затронутые файлы и сохраненные пользовательские настройки.
2. **Diagnostic center:** Java, RAM, disk, backend connectivity, build version, last operation and repair action.
3. **Deep links:** `stardust://invite/...`, `stardust://build/...`, `stardust://news/...`.
4. **Optional mod profiles:** performance, visuals, QoL; resolver зависимостей и объяснение конфликтов.
5. **Session history:** история запусков, длительность, ошибки до join и последние crash reports.
6. **Discord integration:** Rich Presence, account linking и invite-to-play без переноса чата в launcher.
7. **Progress profile:** playtime, achievements, challenges, cosmetic ownership and seasonal rewards.

## P2: админка и community

1. Command palette и глобальный поиск по игрокам, сборкам, логам и операциям.
2. Bulk actions с preview и подтверждением.
3. Incident timeline, broadcast через Telegram и release notes из одного места.
4. Список текущего онлайна и opt-in friends/activity.
5. Group launch: invite party, проверка совместимости и общий переход на сервер.
6. Несколько серверов из одной админки после завершения multi-server model.

## P1: публичный сайт и личный кабинет

Публичный `website/` нужно переделать не как простую страницу скачивания, а как основной web-вход в Stardust. `website` и `admin-web` остаются разными приложениями и разными контейнерами: игроки используют публичный сайт, а сотрудники управляют контентом через отдельную админку и `admin-server`. В качестве UX-референса использовать структуру PepeLand: отдельный личный кабинет, wiki/guides, новости и игровые разделы, но сохранить визуальный язык Stardust и не копировать чужой дизайн.

1. **Личный кабинет через сайт.** Авторизация существующим auth API, профиль игрока, скин и плащ, бейджи/градиенты, статистика, playtime, last joined, достижения и настройки аккаунта.
2. **Безопасная auth-связка.** Единая web-сессия с launcher/backend, Telegram-подтверждение для чувствительных действий и отдельное обязательное Telegram-подтверждение при входе в админку.
3. **Публичные топы.** Рейтинги по времени в игре, убийствам и другим доступным игровым метрикам; страницы игрока, периодические/сезонные таблицы, фильтры и защита от публикации скрытых данных.
4. **Гайды и wiki.** Раздел с категориями, поиском, оглавлением, related links и Markdown-редактором в админке. Минимальные категории: старт, правила, команды, моды, ресурспак, строительство, технические механики и FAQ.
5. **Новости.** Публичная лента и страницы новостей из существующей news-модели, pinned-публикации, excerpt, дата обновления, теги и ссылки на связанные гайды/релизы.
6. **Страница сервера.** Онлайн, состояние сервисов, адрес сервера, текущая сборка, версия Minecraft, правила, ссылки на Discord/Telegram и инструкция по установке лаунчера.
7. **Игровой профиль.** Публичная карточка игрока с opt-in настройкой приватности, косметикой, достижениями, статистикой и историей сезона.
8. **Mobile-first навигация.** Сайт должен одинаково хорошо работать на desktop и mobile: быстрый доступ к «Играть», личному кабинету, топам, гайдам и новостям.
9. **Контентная админка.** CRUD в отдельном `admin-web` для гайдов, категорий, тегов, SEO/meta, черновиков, публикации и предварительного просмотра; публичный `website` только отображает опубликованный контент.
10. **Deep links.** Ссылки из сайта должны открывать launcher: установка, выбранная сборка, новость, гайд или invite-код.

## Non-goals

- встроенный каталог CurseForge/Modrinth;
- произвольная установка неподдержанных модов;
- полноценный универсальный multi-instance launcher без связи с curated-сборками;
- встроенный чат и социальная сеть;
- полноценная панель управления Minecraft-хостингом;
- автоматические опасные действия администратора без подтверждения.

## Порядок ближайших итераций

1. Repair Installation + operation state.
2. Support bundle + diagnostic center.
3. Audit log и session lifecycle.
4. Manifest v2, update preview и rollback.
5. Crash grouping и release health.
6. Multi-server abstraction.
7. Deep links, invite codes и Discord Rich Presence.

Критерий завершения каждой крупной функции: backend/API контракт, launcher/admin UI, миграции при необходимости, тесты и обновление этой документации.
