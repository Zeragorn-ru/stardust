# StarDust Launcher — UX/UI улучшения

## Приоритет 1 (критично)

### 1. Кастомизация — фон
Текущий фон модалки: `rgba(28, 32, 52, 0.72)` + `blur(24px)`. На практике выглядит как серо-синий мутный — не хватает глубины и характера. Overlay без blur (`rgba(5, 6, 12, 0.72)`) делает 3D модель за модалкой тусклой.
**Идеи:**
- Добавить тонкий градиент на overlay (сверху фиолетовый → снизу тёмный) вместо плоского цвета
- Слабое свечение (glow) по краям модалки — `box-shadow: 0 0 80px -20px rgba(124, 92, 255, 0.15)`
- Внутренний градиент на фоне модалки: от `rgba(28, 32, 52, 0.8)` к `rgba(18, 20, 35, 0.9)`

### 2. Кнопка retry при ошибке — сломанные стили
`btn--play-retry` класс не определён в CSS. Кнопка.retry наследует ВСЕ стили play-кнопки: зелёный градиент, 104px высота, пульс. Выглядит нелепо.
**Фикс:** определить `.btn--play-retry` в CSS — нейтральный стиль (glass фон, без зелёного, компактный)

### 3. Login — двойной glass в approval state
Вложенная форма `login__form` внутри `login__form` → двойной padding + двойной glass background. Выглядит как "окошко в окошке".
**Фикс:** убрать стили `.login__form` у вложенной формы, или использовать другой класс

### 4. Анимации выключены — всё выглядит мёртвым
При `data-motion="off"` (reduced motion) все CSS-анимации обнуляются:
- **Экраны появляются без transition** — нет плавного fade/slide, переключение瞬间断ается. Переход между экранами выглядит как "дерганье"
- **Кнопка play без пульса/sheen** — выглядит как статичный зелёный прямоугольник, нет живости
- **Карточки главного меню** — без stagger-анимации появляются все сразу, нет ощущения иерархии
- **Настройки** — навигация без accent bar анимации, табы без ink transition
- **Модалки** — появляются без slide-up, ощущение что "просто включились"
- **Aurora blobs** — статичные, нет drift. Фон выглядит как неподвижный градиент
- **3D модель скина** — idle анимация стоит, модель "мёртвая"
**Нужно:** При reduced motion не обнулять ВСЁ, а заменять на instant transitions. Например:
- Заменять `opacity: 0 → 1` fade на `transition: opacity 0.1s` (быстрый, но заметный)
- Оставлять `transition` для навигации (0.1s вместо 0.3s)
- Play-кнопка: убрать pulse/sheen, но оставить hover-scale
- Aurora: оставить статичный градиент, но с очень медленным drift (60s+)
- Модалки: `opacity` transition 0.12s вместо slide+scale

### 5. Производительность — 30-50% CPU на i7-2620M
На старых dual-core (i7-2620M, 2 cores/4 threads) лаунчер жрёт 30-50% CPU в idle. Это неприемлемо — лаунчер не должен есть столько ресурсов когда ничего не делает.
**Вероятные причины:**
- **WebGL canvas (SkinViewer3D)** — three.js рендерит 60fps даже когда модель не двигается. Нужно `renderer.setAnimationLoop(null)` при idle, или `requestAnimationFrame` только при interaction
- **CSS animations** — `float`, `playPulse`, `sheen`, `aurora drift` работают непрерывно. Каждая анимация = repaint/reflow на каждом кадре
- **Aurora blobs** — три фоновых элемента с `animation: drift 22s` = постоянный composite
- **`backdrop-filter: blur()`** — один из самых дорогих CSS-эффектов. Каждый `.glass` элемент с blur = GPU composition на каждом кадре. Blur на 6+ элементах одновременно
- **setInterval в компонентах** — например, `spawn_stats_poller` каждые 15 минут, но возможны другие интервалы
**Оптимизации:**
1. **SkinViewer3D**: добавить `_idle` флаг. При mouseup + 5s timeout → `renderer.setAnimationLoop(null)` → resume при mousemove/wheel
2. **CSS**: `will-change: transform` только на элементах с анимацией, убрать с остальных
3. **Aurora**: `animation-play-state: paused` при data-motion="off", или `prefers-reduced-motion` media query
4. **backdrop-filter**: рассмотреть `contain: layout style paint` на glass-контейнерах
5. **requestAnimationFrame**: убедиться что нет "голодных" rAF циклов (запускающих repaint без видимых изменений)

## Приоритет 2 (важно)

### 6. Escape закрывает кастомизацию
CustomizeModal не ловит Escape. Нужно добавить `useEffect` с `keydown` listener

### 7. Несохранённые изменения в настройках
При уходе из "Общие" без сохранения — изменения теряются молча. Нужен prompt или auto-save

### 8. "Ник" таб без индикации "в разработке"
Пользователь нажимает таб → видит "В разработке" без объяснения. Добавить lock icon или disabled state

### 9. Success messages не исчезают
В AccountSection сообщения "Имя изменено", "Пароль изменён" остаются навсегда直到 переключения секции

### 10. ErrorBoundary на английском
"Something went wrong" → "Что-то пошло не так". Добавить кнопку "Перезапустить"

## Приоритет 3 (полировка)

### 11. Нет loading skeleton для скина
При загрузке скина 3D модель показывает пустоту. Нужен placeholder/skeleton

### 12. Нет maximize кнопки в title bar
Только minimize + close. Добавить maximize/restore (если поддерживается Tauri)

### 13. Password show/hide toggle
В формах логина и смены пароля нет кнопки "показать пароль"

### 14. "Забыли пароль?" — underline стиль
Underline.link ломает glass-дизайн. Сделать как ghost-кнопку

### 15. Skin-modal: native checkbox vs custom switch
Синхронизация скина использует нативный `input[type=checkbox]` вместо кастомного `.switch`

### 16. Нет "сбросить настройки по умолчанию"
В общих настройках нет кнопки reset

### 17. Нет разделения core/optional модов
Все моды выглядят одинаково — нет визуального различия

### 18. FaceAvatar placeholder слишком минималистичный
Два глаза на сером фоне — можно сделать более выразительный placeholder

## Приоритет 4 (оптимизация)

### 19. Общая оптимизация лаунчера
- **backdrop-filter: blur()** — один из самых дорогих CSS-эффектов. Каждый `.glass` элемент = GPU composition на каждом кадре. Ограничить blur только основными контейнерами, убрать с вложенных элементов
- **CSS containment** — добавить `contain: layout style paint` на стабильные контейнеры (settings, login form) чтобы браузер мог пропускать repaint
- **will-change** — убрать со всех элементов кроме тех которые реально анимируются. `will-change: transform` на `.screen-transition`, `.modal-overlay`, `.aurora__blob`
- **Intersection Observer** — для элементов которые не видны (за пределами экрана)暂停 их анимации
- **requestAnimationFrame throttle** — убедиться что нет "голодных" rAF циклов
- **Bundle size** — проверить импорты, tree-shaking, убрать неиспользуемые зависимости

### 20. Оптимизация для режима без анимаций (data-motion="off")
Когда анимации отключены, лаунчер должен быть максимально лёгким:
- **Aurora blobs** — `animation: none` + `opacity: 0.5` (статичный градиент, без дрейфа)
- **CSS transitions** — `transition: none` вместо `0.1s` (полное отключение)
- **backdrop-filter** — убрать completely с `.glass` элементов (самый дорогой эффект)
- **SkinViewer3D** — при motion off: `pixelRatio: 1` (без супер-сэмплинга), `animation.paused = true`
- **Stagger animations** — `animation: none` (все элементы появляются сразу)
- **Box shadows** — упростить: убрать анимированные тени (playPulse, sheen)
- **Repaint throttle** — увеличить debounce для progress events с 250ms до 1000ms
