# План задач

## Статус

- [x] Telegram в аккаунтах (AdminView — просмотр/ручная установка chat ID)
- [x] Сохранение вкладки при обновлении страницы (localStorage)

---

## Лаунчер (Tauri / React)

### 1. [x] Убрать ПКМ-меню
**Файл:** `launcher/src/main.tsx`  
Добавить одну строку:
```ts
document.addEventListener("contextmenu", (e) => e.preventDefault());
```

### 2. [x] Кривой вид после нажатия «Привязать Telegram» + полоска сверху
**Файл:** `launcher/src/components/AccountSection.tsx`, `launcher/src/styles.css`  
Проблема: блок Telegram 2FA — это `<div className="account-form">` без разделителя.  
После нажатия «Привязать Telegram» показывается блок с `tg-code` и кнопкой, верстка ломается.  
- Добавить `border-top` отступ только между секциями через CSS (`.account-section > .account-form + .account-form`)  
- Убрать лишнюю полоску у кнопки — проверить, откуда берётся (возможно margin/gap)

### 3. [x] Глобальный скроллер при переходе на вкладку настроек
**Файл:** `launcher/src/styles.css`  
`.app__content` или `.app` не имеют `overflow: hidden`, из-за чего при переключении на настройки проскакивает глобальный скроллер.  
Добавить `overflow: hidden` на `.app__content`.  
Строки `.app` [L116-125], `.app__content` [L138-147].

### 4. [x] Унификация кнопок
**Файл:** `launcher/src/styles.css`  
`.btn--ghost` имеет прозрачный фон — при hover фон появляется, при уходе пропадает.  
Дать постоянный слабый фон (как у secondary-кнопок), чтобы кнопки выглядели консистентно.  
Затронуть: `.btn--ghost`, `.btn--ghost:hover:not(:disabled)`.

### 5. Автозапуск после обновления
**Статус: уже реализовано.**  
`launcher/src-tauri/nsis/hooks.nsh` — при `/S` (тихая установка через автообновление) лаунчер запускается автоматически. Галочка «Запустить StarDust после установки» присутствует на финальном экране при обычной установке.  
Ничего делать не нужно.

---

## Бэкенд / Админка

### 6. [x] Настройки Minecraft-сервера через Calagopus Panel API
**Файлы:**
- `crates/admin-server/src/main.rs` — добавить поля в `SettingsDto`, `UpdateSettingsRequest`, `get_settings`, `update_settings`
- `crates/store/src/lib.rs` — новые ключи настроек (константы `SETTING_PANEL_URL`, `SETTING_PANEL_API_KEY`, `SETTING_PANEL_SERVER_ID`)
- `admin-web/src/types.ts` — расширить `Settings`
- `admin-web/src/api.ts` — добавить поля в `setSettings` (или отдельный вызов)
- `admin-web/src/views/SettingsView.tsx` — новая секция «Minecraft-сервер»

**Нужные поля:**
| Поле | Ключ в БД | Описание |
|------|-----------|----------|
| `panelUrl` | `panel_url` | Базовый URL панели (напр. `https://panel.example.com`) |
| `panelApiKey` | `panel_api_key` | Application API key (секрет, не отдавать наружу — только флаг `panelApiKeySet`) |
| `panelServerId` | `panel_server_id` | UUID/ID сервера на панели |

**API-контракт (аналогично telegramToken):**
- `GET /api/settings` — возвращает `panelUrl`, `panelApiKeySet: bool`, `panelServerId`
- `PUT /api/settings` — принимает `panelUrl?`, `panelApiKey?`, `panelServerId?`

**UI:**
- Новая карточка в `SettingsView` с тремя полями
- `panelApiKey` — `type="password"`, показывается только статус «установлен / не установлен»

---

## Очерёдность выполнения

1. Лаунчер: пп. 1–4 (быстрые правки CSS/JS)
2. Бэкенд: п. 6 (настройки панели)
