# План редизайна админки StarDust (admin-web)

Основан на аудите (40+ находок) и личной инвентаризации `admin-web/src`. Цель: одна дизайн-система, один словарь компонентов, одна логика на экран для обоих шеллов (desktop `/` и mobile `/m`), с сохранением 100% функциональности, включая параллельно добавляемый пункт «Скачать папку» в меню папки FileManager. Валидация после каждого шага: `cd /Users/zeragosha/projects/stardust/admin-web && npm run build` (контракт бэкенда не меняем — правило CLAUDE.md).

---

## 1. Фундамент дизайн-системы

### 1.1. Токены: один `:root` вместо двух конфликтующих

Сейчас в `src/styles.css` два полных `:root`: строки 17–63 (старая синяя система, `--accent: #4c8bf5`, `--radius: 9px`) и строки 3398–3423 («2026 redesign», cyan/purple, `--radius: 12px`). Второй частично перекрывает первый — отсюда мёртвый синий `--ring`, смесь радиусов, фиолетовые hover-состояния.

**Сделать:**
- Создать `admin-web/src/styles/tokens.css` — единственный источник токенов. Подключить первой строкой `@import "./styles/tokens.css";` в начале `src/styles.css` (vite склеит; `mobile/main.tsx` уже импортирует `styles.css` перед `mobile.css`, так что токены доступны обоим шеллам).
- В `tokens.css` перенести блок 3398–3423 целиком и дополнить:
  - `--ring: 0 0 0 3px rgba(115, 215, 255, 0.4);` (сейчас живёт мёртвый синий из строки 60);
  - `--radius-sm: 8px;` (пропорционально к 12/20, вместо 6px);
  - `--fs-xs: 11px; --fs-sm: 12px; --fs-md: 13px; --fs-base: 14px; --fs-lg: 16px; --fs-xl: 18px; --fs-2xl: 24px; --fs-hero: clamp(26px, 3vw, 36px);` — взамен 17 захардкоженных размеров;
  - `--faint: #7d8593;` (контраст ≥4.5:1 на `--panel`);
  - `--accent-2: #9d7cff` оставить как **вторую brand-ноту**, не как hover-вариант — см. 1.2.
- Удалить первый `:root` (строки 17–63) полностью. Ниже по файлу добить ~47 литералов `rgba(76,139,245,…)`/`#4c8bf5` (строки 112, 382, 964, 1068, 1224, 1303, 2572 …) → `var(--accent)` или `color-mix(in srgb, var(--accent) 12%, transparent)`.
- `--sp-1..6` (строки 40–46, используются 0 раз) — удалить.
- Тело `body` с фоновыми градиентами из блока 3397+ остаётся в `styles.css`.

### 1.2. Кнопки и интерактивные состояния

Проблема: `--accent-2` в старой системе был hover-оттенком синего, в новой — другим оттенком (фиолетовый #9d7cff). Легаси-правила `button.primary:hover { background: var(--accent-2) }` (строки 240–243), `.build-item:hover` (750), `.fm-row.file.selected` (2572–2573), `.fm-bulk` (2609), FAB в `mobile.css:789` дают фиолетовые вспышки на cyan-UI.

**Сделать:**
- Канонический primary — градиент из строк 3626–3632. Hover: `filter: brightness(1.08)` (без смены background/border). Удалить легаси-hover-правила, использующие `--accent-2`.
- Один destructive-словарь: `variant="destructive"` (см. 1.4) = tinted (`--danger-soft` фон, border 40% danger, текст `--danger`). `danger-solid` остаётся только внутри `ConfirmDialog` в `ui/feedback.tsx` — больше нигде в JSX.
- `:focus-visible` (строки 67–71): убрать `border-radius: var(--radius-sm)` — box-shadow повторяет собственный радиус элемента; сейчас фокус «сплющивает» 12px-кнопки и 999px-чипы в 6px-прямоугольник. Унифицировать `.fm-edit-input:focus` (2103) и `.editor-area:focus` (2798) под общий паттерн border+ring (303–307).

### 1.3. Починить сломанные/мёртвые правила CSS

- `var(--glass-border)`, `var(--glass-border-strong)` (строки 4984, 4994, 5029, 5053 — `.fm-profile-chip*`, `.fm-profile-row`, `.fm-profile-new`) не определены нигде → рамки профилей модов не рендерятся вовсе. Заменить на `var(--border)`/`var(--border-strong)`.
- `var(--text-soft)` (строка 4027, `.overview-hero-pills span`) → `var(--muted)`.
- Дубли: `.telemetry-metrics` дважды (99–100), `.fm-prompt-field` дважды (2719 vs 4678), глобальная таблица (4487–4504) дублирует `.sd-table` (3597–3624) правило-в-правило — оставить одну.
- `CheckResults.tsx` передаёт `className="table"` (строки 46, 88) — класс не существует; заменить на `sd-table-container`/`.sd-table` из 1.4.
- Мёртвый master-detail блок (~90 строк: `.builds-aside`, `.build-list`, `.build-item`, `.sidebar-sub-nav`, строки 700–790) и `.view-head h1` (546, перекрывается `.page-head h1`) — удалить.

### 1.4. Словарь общих компонентов и раскладка файлов

Канон — набор `sd-*` из `src/ui/shadcn.tsx` (уже token-driven, используется SettingsView/AccountsView/OverviewView). Существующие `button.primary/.secondary/.danger` + `.panel/.panel-flat` + `.badge/.tag` — легаси, мигрируем по файлам и удаляем.

Новые файлы (все под `src/ui/` и `src/styles/`):

```
admin-web/src/
  styles/tokens.css          # единственный :root (см. 1.1)
  ui/shadcn.tsx              # +variants: Button(destructive/outline/sm/icon), Badge, Card, Table — канон
  ui/Field.tsx               # Field(label→htmlFor+id) + FieldError(id + aria-describedby + aria-invalid)
  ui/EmptyState.tsx          # LoadPanel / EmptyPanel / ErrorPanel(«Повторить») / StaleBanner
  ui/navConfig.ts            # одна таблицу NAV для sidebar + drawer (label, icon, route, группа)
  ui/useAsyncData.ts         # polling c document.hidden, флаги refreshing/stale/error
  ui/useDirtyGuard.ts        # tryClose() c useConfirm — для всех редакторов
  ui/buildActions.ts         # useBuildActions + EditBuildModal + LOADERS (см. 3.2)
  ui/feedback.tsx            # существующий; +дедуп одинаковых ошибок подряд
  ui/CheckResults.tsx        # фикс className
```

`Field.tsx` закрывает сразу три конвенции ассоциации label/input (htmlFor / обёртка / ничего) и паттерн `CreateBuildForm` (touched+input-error) экспортирует для всех форм.

---

## 2. IA: навигация и структура экранов

### 2.1. Канонические имена маршрутов (сейчас 4 имени на один маршрут)

| Маршрут | Канон | Удалить |
|---|---|---|
| `/settings` | **Настройки** | «Интеграции» (sidebar), «Инфраструктура» (topbar), «Система» (mobile), eyebrow «Инфраструктура» |
| `/customization` | **Кастомизация** | «Косметика» (topbar/mobile), «Кастомизация ника» (h1), «Студия кастомизации» |
| `/accounts` | **Аккаунты** | «Игроки и доступ» (topbar), «Каталог игроков» (eyebrow) |
| `/builds` | **Сборки** | «Сборки и файлы» (topbar) |

Единая таблица `src/ui/navConfig.ts`: `{ tab, label, description, icon, group }`; `DesktopApp.tsx` (sidebar + `sectionDetails`) и `MobileApp.tsx` (NAV) рендерят её — рассинхронизация имён невозможна по построению.

### 2.2. Уникальные иконки (сейчас 3 коллизии)

- Новости и Кастомизация обе `IconStar` → добавить в `src/ui/icons.tsx` `IconMegaphone` (новости);
- Гайды и Логи обе `IconFile` → добавить `IconBookOpen` (гайды), `IconTerminal` (логи);
- Сборки и Внешние моды обе `IconBox` → `IconShield` (уже существует, строки 148) для Внешних модов.

Коллапс-режим сайдбара (`.sidebar-collapsed`, styles.css 3799–3807) скрывает подписи — 4 из 9 пунктов сейчас неотличимы.

### 2.3. Группы навигации

Обзор · **Платформа** (Сборки, Настройки) · **Игроки** (Аккаунты, Кастомизация) · **Контент** (Новости, Гайды) · **Мониторинг** (Логи, Внешние моды). Обновить группы в `navConfig.ts` (desktop sidebar) и убрать декоративные английские eyebrow из mobile-NAV («Dashboard», «Deployment»…).

### 2.4. Слияния/разделения экранов

- **Настройки (`SettingsView.tsx`)** — единственный экран, который реально дробится: из плоской сетки в секции с якорной поднавигацией (scroll-spy по заголовкам):
  1. **Интеграции** — Telegram, SFTP, телеметрия, отпечаток;
  2. **Бекапы** — Yandex S3 + запуск/статус;
  3. **Игра** — «Монеты за достижения»;
  4. **Артефакты** — authlib-injector.jar;
  5. **Лаунчер** (новая, пустая секция-заготовка) — под будущие «выкат pre-release в полноценный релиз», «бета-тестирование», отключение автообновлений;
  6. **Сезоны** (новая, заготовка) — под управление сезонами/статистикой.
  Заготовки = секции с `Card` и коротким описанием, без полей — точки расширения для параллельных агентов, чтобы фичи не свалились в сетку интеграций.
- **Новости/Гайды**: редакторы из модалок → в маршруты (см. 3.6); списки остаются индексами.
- **Логи**: одна лента → вкладки-фильтры по `eventType` (см. 3.7).
- Слияний экранов нет; слияние происходит на уровне логики (`buildActions.ts`, `NewsAdminList`).

### 2.5. Топбар и подмаршруты

`sectionDetails()` в `DesktopApp.tsx` (строки 198–246) научить понимать подмаршрут: `/builds/:id` → title «Детали сборки» (или имя сборки), `/builds/new` → «Новая сборка», `/news/:id|new`, `/guides/:id|new` → аналогично. Убрать дублирование третьего уровня заголовков на хабе сборок (`page-head` h1 + eyebrow + subtitle + topbar title).

---

## 3. Изменения по экранам

Формат: экран → изменения → общие компоненты. Все файлы — реальные пути в `admin-web/src/`.

### 3.1. Обзор — `views/OverviewView.tsx`, `mobile/MobileOverview.tsx`
- Перевести на `ui/useAsyncData.ts`: пауза 30-сек. опроса при `document.hidden`, при возврате — мгновенная догрузка; при сбое фонового обновления — `StaleBanner` с «Повторить» (порт паттерна `LogsView.tsx` 56–82, 120–127) вместо `toast.error` каждые 30 с.
- Удалить нижний `overview-quick-actions` (три конкурирующие группы ссылок на одни и те же 3 маршрута: hero-пилюли, CardAction «Открыть», квик-экшены).
- «Сервисы»-карточка → один адресат: только accounts-статистика; SFTP/Telegram-строки уходят в карточки Метрик/«Инфраструктура» CTA убрать.
- Один обработчик `syncStats` (общий хук в `ui/useAsyncData.ts`): подпись «Синхронизировать статистику», после успеха — `load()` (сейчас Overview не обновляет данные, Accounts — обновляет).
- MobileOverview: убрать инлайн-стили чарта (строки 161–172, старый синий градиент) → классы `.telemetry-chart-wrap/.telemetry-chart`; eyebrow «Веб-приложение для iOS» над «Частые сценарии» → «Быстрый доступ».

### 3.2. Сборки — `BuildDetail.tsx`, `mobile/MobileBuildDetail.tsx`, `desktop/BuildsPage.tsx`, `CreateBuildForm.tsx`
- **Вынести общий слой в `ui/buildActions.ts`**: хук `useBuildActions(buildId, { onChanged, onDeleted, onNavigate })` c `activate/clone/removeBuild/syncToPanel` (+polling 1 с), `deployMod` (+polling 2 с, 5 повторов), `runChecks`, `saveEdit`, `loadSyncStatus(adoptFinished)` — сейчас это построчные копии в двух файлах по ~650 строк. `EditBuildModal` (~120 строк, дублирован) и `LOADERS` (3 копии: BuildDetail 18, MobileBuildDetail 33, CreateBuildForm 8) — туда же. Оба шелла оставляют только раскладку. **Это же — точка входа для будущих действий сборки** (promote pre-release → release, флаг канала): новое действие добавляется в хук один раз и появляется в обоих шеллах.
- Активация: `link-btn activate-btn` (BuildDetail 489–492) → полноценная primary-кнопка в `detail-actions-toolbar` с существующим confirm; бейдж «активная» остаётся состоянием. На хабе — «Сделать активной» в контекстном меню карточки (сейчас вход только через детали).
- «Обновить stardust-mod»: рендерить кнопку только при `detail.isActive` (BuildDetail 515–523, MobileBuildDetail аналог); на неактивной — пассивная строка-ссылка «Мод обновляется в активной сборке — открыть её». Диалог-компенсатор «Мод добавляется только в АКТИВНУЮ…» (393–403) упраздняется.
- 404-ветка: `return null` (463–475) → `EmptyPanel` «Сборка не найдена» + кнопка «К списку сборок» (`navigate("/builds")`), как в MobileBuildDetail.
- Шапка деталей: back-линк на хаб; загрузчик и правки — через `Field`.
- Расширение под каналы релизов (заготовка, если параллельный агент ещё не добавил): строка в `detail-meta-row` с бейджем `sd-badge variant="success"|"outline"` канал `stable|pre-release` и кнопка «Выкатить в релиз» в `detail-actions-toolbar` **через useBuildActions**.

### 3.3. Аккаунты — `views/AccountsView.tsx`, `ui/PlayerCardModal.tsx`, `mobile/MobileAccounts.tsx`
- Убрать N+1: `load()` (115–144) ставит `accounts` и снимает `loading` сразу после `listAccounts()`; статистика грузится в фоне, ячейки playtime/last-join заполняются по мере поступления (плейсхолдер «…»). Долгосрочно — один batched-эндпоинт (вне скоупа UI-плана, пометить TODO).
- Не рефетчить статистику в `PlayerCardModal` InfoTab — передавать уже полученный `stats` пропом.
- Активные фильтры всегда видимы: чипы над таблицей по образцу `.fm-chips` FileManager (query, role, status, telegram, activity — чип с «×» + «Сбросить все»); сейчас сохранённое в localStorage состояние фильтров скрыто за свёрнутой панелью («Аккаунтов пока нет» как ложный вывод).
- `EmptyPanel`/`ErrorPanel` с «Повторить» вместо пустого состояния при сбое загрузки.
- PlayerCardModal: tablist-семантика (`role="tablist"`, `aria-selected`, стрелки), `.pc-active-dot` (10×10) → подписанная кнопка «Сделать активным» с `aria-pressed` и хит-зоной ≥24px; dirty-guard на Badges-табе (см. 4.4); catch-блоки ActionsTab — `err.message`, а не голое «Ошибка»; «Статистика недоступна» в строках при сбое; подсказка «Администратора нельзя забанить/удалить — сначала снимите права» при `account.isAdmin`.

### 3.4. Настройки — `views/SettingsView.tsx`, `mobile/MobileSettings.tsx`
- Секции + якорная поднавигация (2.4), включая заготовки «Лаунчер» и «Сезоны».
- `runBackup()` (206–217): после старта — poll `getBackupStatus()` каждые ~5 с до терминального состояния; статус-строка из enum → человеческий текст («Идёт архивация…», «Последний запуск: …»); кнопка disabled от опрашиваемого статуса, причина рядом.
- Все поля через `Field`; серверные ошибки — inline-панель `role="alert"` рядом с кнопкой + `aria-invalid` на поле, не только toast.

### 3.5. Кастомизация — `views/CustomizationView.tsx`
- Hex-валидация: `.input-error` «Формат: #rgb или #rrggbb» под полем + `aria-invalid`/`aria-describedby` (сейчас кнопка просто молча серая — 323, 404).
- `BadgeModal`/`GradientModal`: dirty-guard (см. 4.4), `Field`, роль-атрибуты диалога.

### 3.6. Новости и Гайды — `views/NewsView.tsx`, `views/GuidesView.tsx`
- Desktop: редакторы → маршруты `/news/new`, `/news/:id`, `/guides/new`, `/guides/:id` по образцу `BuildsPage` (обёртка в `DesktopApp.tsx` routes); широкий лейаут, live-Markdown-превью, dirty-guard на навигацию. Mobile: оставить модалку, но full-screen + превью.
- Dirty-guard (критическая находка): сейчас backdrop-клик/Escape мгновенно стирают до 12 000/40 000 символов — `ui/useDirtyGuard.ts` (паттерн `CreateBuildForm.tryClose` 47–59) на оба редактора. `Ctrl/Cmd+S` = submit.
- Общий компонент `NewsAdminList` (списочные карточки + actions) для обоих экранов — гайды на mobile тогда получают стили новостей автоматически.

### 3.7. Логи и Внешние моды — `views/LogsView.tsx`, `views/ExternalModsView.tsx`
- LogsView: вкладки-фильтры по `eventType` (labels уже есть, строки 9–16); deep-link `?type=external_mods`.
- ExternalModsView: форма «Разрешить по SHA-256» рядом с формой блокировок (или allow/block-тоггл в одной форме) — сейчас allowlist пополняется только из модалки деталей лога; empty-state ссылается на `/logs?type=external_mods`.
- Валидация `/^[a-f0-9]{64}$/i` поля хеша inline до сабмита.
- Mobile: обернуть в `m-screen m-screen-reuse` (сейчас единственный экран без адаптации — `MobileApp.tsx` 205), секция `.m-screen .external-mods-view` в `mobile.css`: кнопки ≥44px, форма в колонку, хеши усечённые.

### 3.8. Файловый менеджер — `FileManager.tsx`, `FileUpload.tsx`, `FileEditor.tsx`, `styles.css`
- **Координация с параллельным изменением**: в `.fm-folder-menu` (FileManager 990–1024) добавляется «Скачать папку» — этот пункт не трогаем и не откатываем; все новые пункты (напр. «Поделиться») добавлять в тот же массив items.
- Рестайл `.fm-row` (1590–1605) под рецепт редизайна: фон `rgba(255,255,255,0.025)`, border `rgba(255,255,255,0.07)`, без 0 10px 28px тени, `var(--radius)`; вложенные радиусы иконок (1816, 1690) — к тому же токену. Выделение/edited — на cyan-акценте.
- Кебаб папок постоянно видим на десктопе (сейчас `opacity: 0` до hover — строки 5156–5168: `.fm-folder-menu { opacity: .6 }`, hover → 1). Ключевое действие скачивания не должно прятаться за ховером; иконка удаления при этом видна всегда — приоритет выправляется.
- «Скопировать ссылку на manifest» — иконка+подпись в тулбаре или меню «Поделиться» (сейчас только tooltip и ПКМ по пустому месту).
- BulkBar: прогресс «N из M» при массовых операциях; при частичном сбое — оставить выбранными только неудавшиеся, список путей с серверным сообщением, кнопка «Повторить для N неудавшихся» (по образцу `FileUpload.uploadAll(true)`).
- Заменить 3 `window.confirm` (FileManager 1383, 1771; FileUpload 505) на `useConfirm({ danger: true })`; закрытие по подложке — через общий `tryClose` с dirty-проверкой (образец — `EditBuildModal` из MobileBuildDetail 569–581; в iOS standalone-PWA `window.confirm` вообще не отображается и возвращает false).
- `PromptDialog`/`ModProfilesDialog`/`FileEditor` — `useDialogFocus(dialogRef, …)` (фокус-ловушка, Escape, возврат фокуса), `role="dialog" aria-modal aria-labelledby`; `ModProfilesDialog.save()` — `toast.success("Профиль сохранён")`.
- Сегмент-контролы (`seg-btn`, FileSettingsDrawer 2099–2125, BulkBar 1150–1283): `aria-pressed={selected}` (паттерн `.fm-profile-chip` уже в тех же файлах).
- QueueRow/батч-панель FileUpload: ассоциация label через `Field`.

### 3.9. Логины — `Login.tsx`, `mobile/MobileLogin.tsx`
- Десктопный Login обновить под рецепт `m-login-card`/`m-brand-mark` (сейчас легаси `brand-dot` со старым синим свечением, 377–383, 679) — первый экран должен соответствовать приложению.

---

## 4. Инфраструктура состояния и фидбека

### 4.1. Единый useConfirm
Все 3 оставшихся `window.confirm` → `useConfirm` (4.8 выше). Нативные диалоги замораживают страницу, ломаются в iOS PWA и выбиваются из визуального языка; styled-диалог с focus/danger-конвенциями уже существует (`ui/feedback.tsx` 153–225).

### 4.2. Empty/Loading/Error/Stale — `ui/EmptyState.tsx`
Канонический паттерн (порт из LogsView 106–127): `ErrorPanel` с «Повторить» — когда данных нет и загрузка упала; `EmptyPanel` («Создайте первую…») — только после успешной загрузки; `StaleBanner` — фоновый сбой при непустом списке. Применить во всех экранах, где сейчас сбой выглядит как «пусто»: MobileBuilds («Сборок пока нет» при упавшем `listBuilds`), AccountsView, NewsView, GuidesView, CustomizationView, SettingsView (карточки статуса показывают «не настроен» при ошибке — отличить ошибку от отсутствия конфига).

### 4.3. Опрос и тосты
- `ui/useAsyncData.ts`: интервалы останавливаются на `document.hidden`, на возврате — немедленный refresh (паттерн LogsView); защита от наложения запросов (`inFlight` ref).
- `FeedbackProvider`: дедуп подряд одинаковых `toast.error` (сейчас ошибка обзора повторяется каждые 30 с); CSS-сдвиг тостов на mobile выше FAB и нижних баров: `.toast-stack { bottom: calc(88px + env(safe-area-inset-bottom)) }` в мобильном блоке (сейчас full-width плашка z-index 1000 перекрывает FAB «Создать сборку» на 6 секунд при ошибке сохранения).

### 4.4. Dirty-guard — `ui/useDirtyGuard.ts`
Один хук `useDirtyGuard(isDirty, isBusy, onClose)`: Escape и backdrop-клик → `useConfirm("Есть несохранённые изменения", danger)`. Применить к: `NewsEditor`, `GuideEditor`, `BadgeModal`, `GradientModal`, `PlayerCardModal` (Actions/Badges-вкладки) — единственные редакторы без защиты, и именно с самым большим объёмом текста. Существующие защищённые (`EditBuildModal`, `CreateBuildForm`, `FileSettingsDrawer`, `PromptDialog`, `ModProfilesDialog`) переводятся на общий хук.

### 4.5. Формы
- `ui/Field.tsx`: `htmlFor`+`id`, `FieldError` с `id` + `aria-describedby` + `aria-invalid`. Миграция ~40 полей: CreateBuildForm, оба EditBuildModal (уходят в buildActions), BadgeModal/GradientModal, QueueRow, ModProfilesDialog.
- Серверные ошибки — персистентно: inline-панель `role="alert"` у кнопки + `aria-invalid` поля, toast остаётся как сигнал (сейчас через 6 с от ошибки не остаётся следа).

---

## 5. Мобильная стратегия

Принцип: **один слой данных и действий, две раскладки** — не два приложения. Общий: `api`, `types`, `buildActions`, все `ui/*`, `FileManager`, `NewsAdminList`; мобильное — только шелл (`MobileApp`, `m-screen*` CSS).

- `MobileApp.tsx` `closeBuild()` (119–122): вместо `pushState(?tab=builds)` — `window.history.back()`, когда текущая запись создана `openBuild` (флаг в `history.state`); сейчас системный Back реоткрывает закрытую сборку — цикл «закрыл → Back → снова открылось».
- Кнопка «назад» из деталей сборки — дублировать в sticky `m-shell-head` (сейчас она в прокручиваемом контенте и уезжает).
- Один CSS-правило против iOS-зума: `.m-app input, .m-app select, .m-app textarea { font-size: 16px }` (m-login — вне `.m-screen`, но внутри `.m-app`); удалить точечные дубли для `.fm-upload`/news-editor; ниже 520px можно вернуть 14px визуально через transform/масштаб — не трогать font-size.
- `m/index.html`: убрать `maximum-scale=1.0` (запрет пинч-зума, WCAG 1.4.4), оставить `viewport-fit=cover`.
- Drawer: фокус в первый `.m-drawer-item` при открытии, возврат на кнопку-гамбургер при закрытии (переиспользовать `useDialogFocus`).
- Гайды: через общий `NewsAdminList` получают мобильные стили новостей (sticky-голова, 44px-кнопки) — сейчас `guides-view--mobile` не имеет ни одного CSS-правила.
- Мобильные тосты — см. 4.3.
- `mobile.css` 1101: комментарий «на десктопе secondary нет» устарел (styles.css 3634 определяет) — удалить дублирующее правило.

---

## 6. Порядок миграции (валидация после каждого шага)

Каждый шаг завершать: `cd /Users/zeragosha/projects/stardust/admin-web && npm run build` (первый раз — `npm ci --ignore-scripts`), затем визуальный смоук по затронутым экранам в обоих шеллах.

| # | Шаг | Затрагивает | Риск/проверка |
|---|---|---|---|
| 0 | Базлайн: сборка зелёная до изменений | — | зафиксировать стартовое состояние |
| 1 | **Токены**: `styles/tokens.css`, удалить старый `:root`, `--ring`/`--radius-sm`/`--fs-*`, sweep синих литералов, hover-primary, `:focus-visible`, битые `--glass-border`/`--text-soft`, дубли правил | только CSS | вся аппа; проверить primary-кнопки, фокус-ринги, профили модов |
| 2 | **Инфра-компоненты**: `Field`, `EmptyState`, `useAsyncData`, `useDirtyGuard`, `navConfig`, toast-дедуп + mobile-сдвиг | новые файлы + `feedback.tsx`, CSS | компилируется, ничего ещё не потребляет |
| 3 | **Навигация**: `navConfig` в `DesktopApp`/`MobileApp`, уникальные иконки, канонические имена, подмаршруты в `sectionDetails`, persist sidebar в localStorage, удаление quick-actions с Overview | 2 файла + icons | имена и иконки во всех четырёх местах совпадают |
| 4 | **Общий слой сборок**: `ui/buildActions.ts` (useBuildActions + EditBuildModal + LOADERS + polling); `BuildDetail`/`MobileBuildDetail`/`CreateBuildForm` потребляют; активация primary-кнопкой; deployMod только на active; 404-ветка | 3 файла | полный паритет действий desktop/mobile; проверить активацию/клон/удаление/SFTP-синх/деплой мода/проверки в обоих шеллах |
| 5 | **Фидбек**: замена 3 `window.confirm`, dirty-guard на News/Guide/Badge/Gradient/PlayerCard редакторах, bulk-прогресс в BulkBar, Accounts stats split-phase | FileManager, FileUpload, News, Guides, Customization, PlayerCard, Accounts |.dirty-guard на Escape и backdrop; очередь очистки |
| 6 | **Экраны 1**: Overview (useAsyncData, stale, один syncStats), Settings (секции + заготовки «Лаунчер»/«Сезоны», backup-poll), Accounts (чипы фильтров, stats-фон), Customization (hex-валидация) | 4 view | секции настроек с якорями; фильтры-чипы видны после возврата |
| 7 | **Экраны 2**: News/Guides → маршруты-редакторы + `NewsAdminList`, Logs-вкладки `?type=`, ExternalMods allow-форма + валидация хеша, FileManager-рестайл + видимый кебаб (не трогая «Скачать папку»), CheckResults className, Login-десктоп | 6+ файлов | deep-links `/news/:id`; скачать-папку работает в новом меню |
| 8 | **Мобильный паритет**: `m-screen-reuse` для mods, guides через NewsAdminList, 16px-инпуты, viewport, closeBuild back, sticky-назад, drawer-фокус, MobileBuildDetail sync busy, MobileOverview чарт/eyebrow | mobile/* | тап-цепочки на телефоне, iOS PWA confirm'ы |
| 9 | **A11y/полировка**: tablist в PlayerCard, aria-pressed сегментов, Field-миграция оставшихся форм, focus-ловушки диалогов, `--faint`-контраст, подсказки disabled, типовая шкала, удаление мёртвого CSS (master-detail, легаси-логин, `view-head h1`) | по всем | таб-навигация сквозь аппу |
| 10 | **Финал**: grep-чеки — `window.confirm` (0), `rgba(76,139,245|#4c8bf5` (0), `var(--glass-border|--text-soft` (0), undefined `var(--x)` в целом; `npm run build`; ручной смоук-лист по всем 9 разделам в обоих шеллах | — | готово |

Порядок выбран так, чтобы каждый шаг был независимо собираемым и обратимым: сначала чистый CSS (ноль JSX-риска), затем новые модули (ноль потребителей), затем навигация, затем дедупликация логики до миграции экранов (иначе экраны пришлось бы переделывать дважды), и только в конце — удаление легаси-классов, когда JSX уже мигрирован.

**Для параллельных агентов (каналы релизов, бета-тест, сезоны):** точки интеграции — `ui/buildActions.ts` (действия сборки: promote-to-release, канал), секции «Лаунчер»/«Сезоны» в `SettingsView.tsx` (2.4), `navConfig.ts` (если появится новый раздел). Ничего из этого в текущем плане не реализуется — только зарезервировано.