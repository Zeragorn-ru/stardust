// Фокус-ловушка диалога: стартовый фокус, Tab-цикл внутри узла, Escape,
// возврат фокуса на элемент, который был активен до открытия.
//
// Опции (план 5, шаг 8 — drawer мобильного шелла): узел, который смонтирован
// всегда, а не только пока «открыт», передаёт active; стартовый фокус можно
// задать селектором (первый .m-drawer-item), а возврат — явным ref
// (кнопка-гамбургер), потому что на iOS тап по кнопке не фокусирует её.

import { useEffect, useRef, type RefObject } from "react";

const FOCUSABLE = [
  "a[href]",
  "button:not(:disabled)",
  "input:not(:disabled)",
  "select:not(:disabled)",
  "textarea:not(:disabled)",
  "[tabindex]:not([tabindex=\"-1\"])",
].join(",");

export interface UseDialogFocusOptions {
  /** Ловушка активна (по умолчанию true — узел смонтирован только в открытом состоянии). */
  active?: boolean;
  /** Селектор элемента стартового фокуса; без него — первый фокусимый узел. */
  focusSelector?: string;
  /** Явная цель возврата фокуса; без неё — элемент, активный до открытия. */
  returnFocus?: RefObject<HTMLElement | null>;
}

export function useDialogFocus<T extends HTMLElement>(
  dialogRef: RefObject<T | null>,
  onEscape?: () => void,
  options: UseDialogFocusOptions = {},
): void {
  const escapeRef = useRef(onEscape);
  escapeRef.current = onEscape;
  // Остальные опции читаем на момент срабатывания эффекта через ref,
  // чтобы объект-литерал не перевязывал эффект на каждом рендере.
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const { active = true } = options;

  useEffect(() => {
    if (!active) return;
    const node = dialogRef.current;
    if (!node) return;
    const dialog: HTMLElement = node;

    const { focusSelector, returnFocus } = optionsRef.current;
    const previous = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    const focusables = () => Array.from(node.querySelectorAll<HTMLElement>(FOCUSABLE));
    const initial =
      (focusSelector ? node.querySelector<HTMLElement>(focusSelector) : null) ??
      focusables()[0] ??
      node;
    initial.focus();

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        escapeRef.current?.();
        return;
      }
      if (event.key !== "Tab") return;

      const elements = focusables();
      if (elements.length === 0) {
        event.preventDefault();
        dialog.focus();
        return;
      }

      const firstElement = elements[0];
      const lastElement = elements[elements.length - 1];
      if (event.shiftKey && document.activeElement === firstElement) {
        event.preventDefault();
        lastElement.focus();
      } else if (!event.shiftKey && document.activeElement === lastElement) {
        event.preventDefault();
        firstElement.focus();
      }
    }

    node.addEventListener("keydown", onKeyDown);
    return () => {
      dialog.removeEventListener("keydown", onKeyDown);
      // Явная цель возврата надёжнее previous: на iOS тап не фокусирует
      // кнопку, и previous мог оказаться body.
      (returnFocus?.current ?? previous)?.focus();
    };
  }, [active, dialogRef, optionsRef]);
}
