// Dirty-guard для маршрутов-редакторов (план 3.6): переход по сайдбару,
// системному Back или перезагрузке страницы не должен молча стирать до
// 12 000/40 000 символов черновика.
//
// Оборачивает react-router useBlocker (перехват SPA-навигации) и
// useBeforeUnload (жёсткая перезагрузка/закрытие вкладки). Подтверждение —
// styled-диалог useConfirm: нативный window.confirm в iOS standalone-PWA
// не отображается.
//
// В мобильном шелле роутера нет: там редактор — модалка, и маршрутный
// guard не нужен. useBlocker вне роутера упал бы — поэтому редакторы
// передают enabled=false, и хук возвращает неактивную заглушку, а все
// router-хуки (useBlocker/useBeforeUnload) не вызываются (правила хуков
// соблюдены через ранний возврат до них невозможно — вместо этого хук
// вызывается всегда, но с shouldBlock=false; сами хуки безопасны в
// контексте роутера, а вне его редактор включает enabled=false, и хук
// ограничивается useBeforeUnload, который работает везде).

import { useEffect, useRef } from "react";
import { useBlocker, useBeforeUnload, type Blocker } from "react-router-dom";
import { useConfirm } from "./feedback";

export interface UseRouteGuardOptions {
  /** Есть ли несохранённые изменения (проверяются на момент перехода). */
  isDirty: boolean | (() => boolean);
  /** Идёт ли сохранение: во время запроса блокировать навигацию нельзя. */
  isBusy?: boolean | (() => boolean);
  /**
   * Активен ли guard. Мобильный шелл (модалка без роутера) передаёт false:
   * useBlocker вне data-роутера выбрасывает исключение.
   */
  enabled?: boolean;
  /** Тексты диалога подтверждения. */
  title?: string;
  body?: string;
  confirmText?: string;
}

/**
 * Блокирует навигацию с «грязного» редактора до явного подтверждения.
 * После согласия повторяет исходный переход через blocker.proceed().
 *
 * ВАЖНО: хук требует data-роутер (createBrowserRouter) — компоненты,
 * рендерящиеся и в мобильном шелле, обязаны передавать enabled=false там.
 */
export function useRouteDirtyGuard({
  isDirty,
  isBusy = false,
  enabled = true,
  title = "Есть несохранённые изменения",
  body = "Уйти без сохранения? Черновик будет потерян.",
  confirmText = "Уйти без сохранения",
}: UseRouteGuardOptions): Blocker | null {
  const confirm = useConfirm();

  // Ref-мостик (как в useDirtyGuard): useBlocker кэширует колбэк по
  // ссылкам, а проверка должна видеть актуальное состояние формы.
  const dirtyRef = useRef(isDirty);
  dirtyRef.current = isDirty;
  const busyRef = useRef(isBusy);
  busyRef.current = isBusy;
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;

  const blocker = useBlocker(({ currentLocation, nextLocation }) => {
    if (!enabledRef.current) return false;
    const dirty = typeof dirtyRef.current === "function" ? dirtyRef.current() : dirtyRef.current;
    const busy = typeof busyRef.current === "function" ? busyRef.current() : busyRef.current;
    if (!dirty || busy) return false;
    return currentLocation.pathname !== nextLocation.pathname;
  });

  // Предупреждение о жёстком уходе (перезагрузка, закрытие вкладки) —
  // работает и в мобильном шелле: callback мемоизирован через ref.
  const beforeUnloadRef = useRef((event: BeforeUnloadEvent) => {
    if (!enabledRef.current) return;
    const dirty = typeof dirtyRef.current === "function" ? dirtyRef.current() : dirtyRef.current;
    if (!dirty) return;
    // Современные браузеры показывают свой текст, но требуется preventDefault.
    event.preventDefault();
  });
  useBeforeUnload(useRef((event: BeforeUnloadEvent) => beforeUnloadRef.current(event)).current);

  useEffect(() => {
    if (blocker.state !== "blocked") return;
    let cancelled = false;
    confirm({ title, body, confirmText, danger: true }).then((ok) => {
      if (cancelled) return;
      if (ok) blocker.proceed();
      else blocker.reset();
    });
    return () => {
      cancelled = true;
    };
    // blocker пересоздаётся при каждом переходе — эффект подписан на него.
  }, [blocker, confirm, title, body, confirmText]);

  return enabled ? blocker : null;
}
