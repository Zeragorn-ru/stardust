# StarDust Launcher — UX/UI улучшения

## Приоритет 1 (критично)

### 1. ✅ Кастомизация — фон
Градиент на overlay, glow по краям модалки, внутренний градиент на фоне.

### 2. ✅ Кнопка retry при ошибке
`.btn--play-retry` — нейтральный glass стиль, без зелёного.

### 3. ✅ Login — двойной glass в approval state
Убраны стили `.login__form` у вложенной формы.

### 4. ✅ Анимации выключены — instant transitions
При `data-motion="off"`: быстрые transition (0.1s), backdrop-filter отключен, stagger мгновенный.

### 5. ✅ Производительность — SkinViewer3D idle
Автопауза рендера при потере фокуса или 8с бездействия мыши.

## Приоритет 2 (важно)

### 6. ✅ Escape закрывает кастомизацию
`useEffect` с keydown listener.

### 7. ✅ Несохранённые изменения в настройках
`window.confirm` при уходе с немодифицированными настройками.

### 8. ✅ "Ник" таб — lock icon + "coming soon"
Замок + подсказка "Смена ника будет доступна в следующем обновлении".

### 9. ✅ Success messages исчезают через 3 сек
Автоскрытие nameMsg/pwMsg через setTimeout.

### 10. ✅ ErrorBoundary на русском
Русский текст + кнопка "Перезапустить".

## Приоритет 3 (полировка)

### 11. ✅ Stats skeleton loading
Shimmer placeholder пока грузится статистика на MainScreen.

### 12. ✅ Maximize кнопка в title bar
Кнопка "Развернуть" между minimize и close.

### 13. ✅ Password show/hide toggle
`PasswordInput` компонент с кнопкой visibility.

### 14. ✅ "Забыли пароль?" — ghost кнопка
Убран underline стиль, используется `.btn--ghost`.

### 15. ✅ Skin-modal: custom switch
Нативный checkbox заменён на `.switch` компонент.

### 16. ✅ Сброс настроек по умолчанию
Кнопка "Сбросить настройки по умолчанию" в общих настройках.

### 17. ✅ Mods filter always visible
Фильтр модов показывается при >0 модов (было >3).

### 18. ✅ FaceAvatar placeholder
Градиентный фон, скруглённая голова, глаза + рот вместо двух точек.

## Приоритет 4 (оптимизация)

### 19. ✅ CSS containment + backdrop-filter disable
`contain: layout style` на стабильных контейнерах, backdrop-filter отключен при motion-off.

### 20. ✅ Оптимизация для режима без анимаций
Aurora paused, CSS transitions none, SkinViewer3D pixelRatio 1, stagger none.

## Дополнения (v0.4.77+)

### 21. ✅ Server ping color indicator
Зелёный <80мс, жёлтый <200мс, красный >200мс.

### 22. ✅ Approval state pulse animation
Текст "ожидаем ответ" пульсирует во время ожидания Telegram.

### 23. ✅ Loading spinners for Settings + Mods
Спиннер вместо plain text при загрузке настроек и списка модов.
