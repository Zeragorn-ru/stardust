# Улучшение апдейтера — UX/UI план

## Проблемы текущей реализации

### 1. Нет прогресса загрузки
`install_update` в `update.rs` **никогда не отправляет** событие `launcher://update-progress`. Прогресс-бар в UI всегда неопределённый (indeterminate). Пользователь видит "Загрузка…" без процента.

### 2. Нет информационности
Пользователь не знает:
- Что сейчас происходит (скачивание установщика? проверка хеша? запуск bootstrap?)
- Размер файла и скорость загрузки
- Сколько осталось ждать

### 3. Нет retry при ошибке
При любой ошибке (сеть, хеш, bootstrap) — пользователь должен вручную нажимать "Обновить" снова. Нет автоматического повтора.

### 4. Дублирование кода
`UpdateModal` и `SettingsScreen` — два отдельных компонента с логикой обновления. Дублируют `handleInstall`, `onUpdateProgress`, стейт.

### 5. Bootstrap не показывает реальный прогресс
Прогресс-бар в bootstrap.exe —时间-based (0-3s синусоида), не отражает реальную установку. NSIS не отдаёт прогресс.

### 6. Ошибки на Rust-языке
Сообщения ошибки приходят как raw Rust strings: `"Не удалось скачать установщик: reqwest::Error..."`. Не пользовательский формат.

### 7. Нет "Что нового"
Release notes показываются как plain text в `<pre>`. Без форматирования, без визуального акцента.

---

## Решения

### A. Пошаговый прогресс в Rust (`update.rs`)

Добавить Tauri event `launcher://update-progress` с payload `{ phase, fraction, label }`:

```
Phase 1: downloading_bootstrap  (0.0 - 0.3)
Phase 2: downloading_installer  (0.3 - 0.85)  
Phase 3: verifying_sha256       (0.85 - 0.95)
Phase 4: launching              (0.95 - 1.0)
```

Каждый шаг обновляет fraction. При скачивании — реальный прогресс по байтам (content-length + downloaded).

### B. Размер файла и скорость

`GhAsset` уже содержит `browser_download_url`. Добавим:
- `size: u64` в `GhAsset` (GitHub API отдаёт `size` в байтах)
- При скачивании: считаем скорость (байты/сек) и ETA
- Отправляем в UI: `{ fraction, speed, eta, label }`

### C. Retry при сетевых ошибках

3 попытки с exponential backoff (2s, 4s, 8s) для:
- Скачивания установщика
- Скачивания .sha256
- Скачивания bootstrap

При ошибке хеша — **без retry** (файл повреждён, повтор не поможет).

### D. Единый UpdateModal

Вынести общую логику в `UpdateModal`. Убрать дублирование из `SettingsScreen`.
`SettingsScreen` будет использовать тот же `UpdateModal` (или smaller inline version).

### E. Улучшенный UI

```
┌─────────────────────────────────────┐
│  ★ Доступно обновление              │
│                                     │
│  0.4.57 → 0.4.58                   │
│                                     │
│  ┌─ Что нового ──────────────────┐  │
│  │ • Исправлен краш при запуске  │  │
│  │ • Улучшена скорость загрузки  │  │
│  └───────────────────────────────┘  │
│                                     │
│  Скачивание: 45%  1.2 МБ/с  ~8с    │
│  ━━━━━━━━━━━━━━━━━━━░░░░░░░░░░░░░  │
│                                     │
│  [Позже]              [Обновить]    │
└─────────────────────────────────────┘
```

- Показываем версию "от → до"
- Release notes в стилизованном блоке с буллетами
- Прогресс-бар с процентом, скоростью и ETA
- Кнопка "Обновить" → "Обновление…" → "Повторить" (при ошибке)

### F. Красивые release notes

Парсинг простого markdown:
- Строки с `•` или `-` в начале → буллеты
- `**текст**` → жирный
- Переносы строк сохраняются

---

## Файлы для изменения

| Файл | Изменения |
|------|-----------|
| `launcher/src-tauri/src/update.rs` | Progress events, retry logic, file size, speed tracking |
| `launcher/src/types.ts` | Расширить `Progress` для update phases, добавить `UpdateProgress` |
| `launcher/src/api.ts` | Обновить `onUpdateProgress` тип |
| `launcher/src/components/UpdateModal.tsx` | Полный редизайн: step-by-step, speed, ETA, retry |
| `launcher/src/components/SettingsScreen.tsx` | Убрать дублирующий update card, использовать UpdateModal |
| `launcher/src/App.tsx` | Обновить передачу пропсов |
| `launcher/src/styles.css` | Новые стили для update modal |

## Порядок реализации

1. Rust: Progress events в `download_asset` + фазы ✅
2. Rust: Retry logic для скачиваний ✅
3. Rust: Размер файла из GitHub API (`size` field) ✅
4. TS: Типы и API ✅
5. UI: UpdateModal редизайн ✅
6. UI: Убрать дублирование из SettingsScreen ✅
7. CSS: Стили (в процессе)
8. Bootstrap: Убрать синусоиду, показать реальную фазу
9. **Проверка логики bootstrap**: протестировать полный цикл обновления end-to-end: скачивание → SHA-256 → запуск bootstrap → NSIS тихая установка → запуск нового лаунчера. Убедиться что bootstrap.exe корректно receiving аргументы, process handle работает, фазы переключаются, лаунчер перезапускается.
