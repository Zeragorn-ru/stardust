import { useEffect, useRef, useState } from "react";

export interface ConfirmRequest {
  title: string;
  /** Многострочный текст (\n переносится). */
  body?: string;
  /** Опасное действие — кнопка подтверждения выделяется красным. */
  danger?: boolean;
  confirmText?: string;
  cancelText?: string;
}

interface Props extends ConfirmRequest {
  onResolve: (ok: boolean) => void;
}

/**
 * Замена window.confirm: WKWebView на macOS не реализует
 * runJavaScriptConfirmPanelWithMessage и window.confirm всегда возвращает
 * false, из-за чего подтверждения молча блокировали действия.
 */
export default function ConfirmDialog({
  title,
  body,
  danger = false,
  confirmText = "Подтвердить",
  cancelText = "Отмена",
  onResolve,
}: Props) {
  const [busy, setBusy] = useState(false);
  const onResolveRef = useRef(onResolve);
  onResolveRef.current = onResolve;
  const dialogRef = useRef<HTMLDivElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onResolveRef.current(false);
        return;
      }
      // Простой фокус-трап: Tab гуляет только по кнопкам диалога, иначе
      // Enter мог бы активировать кнопку-триггер под оверлеем.
      if (e.key === "Tab") {
        const buttons = dialogRef.current?.querySelectorAll<HTMLButtonElement>(
          "button:not(:disabled)",
        );
        if (!buttons || buttons.length === 0) return;
        const first = buttons[0];
        const last = buttons[buttons.length - 1];
        if (document.activeElement === last && !e.shiftKey) {
          e.preventDefault();
          first.focus();
        } else if (document.activeElement === first && e.shiftKey) {
          e.preventDefault();
          last.focus();
        } else if (!dialogRef.current?.contains(document.activeElement)) {
          e.preventDefault();
          first.focus();
        }
      }
    }
    // Capture: перехватываем раньше Escape-обработчиков настроек/приложения.
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, []);

  // Фокус сразу в диалог — клавиатурный пользователь не «теряется»
  // на элементе под оверлеем. «Отмена» — безопасное действие по Enter.
  useEffect(() => {
    cancelRef.current?.focus();
  }, []);

  function finish(ok: boolean) {
    if (busy) return;
    setBusy(true);
    onResolve(ok);
  }

  return (
    <div
      className="modal-overlay"
      onClick={(e) => {
        // Выделение текста, протащенное из диалога наружу, не должно
        // отменять подтверждение: реагируем только на прямой клик по подложке.
        if (e.target === e.currentTarget) finish(false);
      }}
      role="presentation"
    >
      <div
        ref={dialogRef}
        className="modal confirm-modal"
        role="alertdialog"
        aria-modal="true"
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
      >
        <header className="modal__header">
          <h2>{title}</h2>
        </header>
        {body && <p className="confirm-modal__body">{body}</p>}
        <footer className="modal__footer">
          <button
            type="button"
            className="btn btn--ghost"
            ref={cancelRef}
            onClick={() => finish(false)}
            disabled={busy}
          >
            {cancelText}
          </button>
          <button
            type="button"
            className={"btn " + (danger ? "btn--danger" : "btn--primary")}
            onClick={() => finish(true)}
            disabled={busy}
          >
            {confirmText}
          </button>
        </footer>
      </div>
    </div>
  );
}
