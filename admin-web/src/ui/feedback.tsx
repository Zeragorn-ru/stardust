// Тосты и модальное подтверждение — единая точка обратной связи.
// Логика портирована из проверенной версии (дедуп ошибок polling-циклов,
// безопасный фокус в опасных подтверждениях), презентация — новая.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useBodyScrollLock } from "./useBodyScrollLock";
import { useDialogFocus } from "./useDialogFocus";
import { Button } from "./components";
import { IconAlert, IconCheck, IconClose, IconInfo } from "./icons";

// ───────────────────────── Типы и контексты ─────────────────────────

export type ToastKind = "success" | "error" | "info";

interface Toast {
  id: number;
  kind: ToastKind;
  text: string;
}

interface ToastApi {
  success(text: string): void;
  error(text: string): void;
  info(text: string): void;
}

interface ConfirmOptions {
  title: string;
  body?: string;
  confirmText?: string;
  danger?: boolean;
}

type ConfirmFn = (opts: ConfirmOptions) => Promise<boolean>;

const ToastCtx = createContext<ToastApi | null>(null);
const ConfirmCtx = createContext<ConfirmFn | null>(null);

export function useToast(): ToastApi {
  const ctx = useContext(ToastCtx);
  if (!ctx) throw new Error("useToast вне FeedbackProvider");
  return ctx;
}

export function useConfirm(): ConfirmFn {
  const ctx = useContext(ConfirmCtx);
  if (!ctx) throw new Error("useConfirm вне FeedbackProvider");
  return ctx;
}

// ───────────────────────── Провайдер ─────────────────────────

interface ConfirmState extends ConfirmOptions {
  resolve: (ok: boolean) => void;
}

export function FeedbackProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [confirmState, setConfirmState] = useState<ConfirmState | null>(null);
  const nextId = useRef(1);
  // Дедуп одинаковых ошибок подряд: фоновый опрос не должен заливать
  // экран одинаковыми плашками.
  const lastError = useRef<{ text: string; id: number } | null>(null);

  const dismiss = useCallback((id: number) => {
    setToasts((list) => list.filter((t) => t.id !== id));
    const last = lastError.current;
    if (last && last.id === id) lastError.current = null;
  }, []);

  const push = useCallback(
    (kind: ToastKind, text: string) => {
      const id = nextId.current++;
      if (kind === "error" && lastError.current?.text === text) return;
      if (kind === "error") lastError.current = { text, id };
      setToasts((list) => [...list, { id, kind, text }]);
      const ttl = kind === "error" ? 6000 : 3500;
      window.setTimeout(() => dismiss(id), ttl);
    },
    [dismiss],
  );

  const toastApi = useMemo<ToastApi>(
    () => ({
      success: (t) => push("success", t),
      error: (t) => push("error", t),
      info: (t) => push("info", t),
    }),
    [push],
  );

  const confirm = useCallback<ConfirmFn>((opts) => {
    return new Promise<boolean>((resolve) => {
      setConfirmState({ ...opts, resolve });
    });
  }, []);

  function closeConfirm(ok: boolean) {
    setConfirmState((cur) => {
      cur?.resolve(ok);
      return null;
    });
  }

  return (
    <ToastCtx.Provider value={toastApi}>
      <ConfirmCtx.Provider value={confirm}>
        {children}
        <div className="toast-stack">
          {toasts.map((t) => (
            <div
              key={t.id}
              className={`toast toast-${t.kind}`}
              onClick={() => dismiss(t.id)}
              role={t.kind === "error" ? "alert" : "status"}
            >
              <span className="toast-icon" aria-hidden="true">
                {t.kind === "success" ? (
                  <IconCheck size={16} />
                ) : t.kind === "error" ? (
                  <IconAlert size={16} />
                ) : (
                  <IconInfo size={16} />
                )}
              </span>
              <span className="toast-text">{t.text}</span>
              <button
                type="button"
                className="toast-close"
                aria-label="Закрыть"
                onClick={(e) => {
                  e.stopPropagation();
                  dismiss(t.id);
                }}
              >
                <IconClose size={13} />
              </button>
            </div>
          ))}
        </div>
        {confirmState && (
          <ConfirmDialog state={confirmState} onClose={closeConfirm} />
        )}
      </ConfirmCtx.Provider>
    </ToastCtx.Provider>
  );
}

function ConfirmDialog({
  state,
  onClose,
}: {
  state: ConfirmState;
  onClose: (ok: boolean) => void;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const confirmBtnRef = useRef<HTMLButtonElement>(null);
  useBodyScrollLock();
  useDialogFocus(dialogRef, () => onClose(false));
  // Безопасные подтверждения: фокус сразу на кнопке подтверждения (Enter —
  // подтверждает). Опасные: фокус на «Отмене», случайный Enter безопасен.
  useEffect(() => {
    if (!state.danger) confirmBtnRef.current?.focus();
  }, [state.danger]);
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose(false);
      }
      if (
        e.key === "Enter" &&
        !state.danger &&
        !(e.target instanceof HTMLButtonElement)
      ) {
        onClose(true);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, state.danger]);

  return (
    <div className="modal-backdrop" onClick={() => onClose(false)}>
      <div
        ref={dialogRef}
        className="modal modal-md"
        role="dialog"
        aria-modal="true"
        aria-labelledby="confirm-dialog-title"
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-body modal-body-confirm">
          <h3 id="confirm-dialog-title">{state.title}</h3>
          {state.body && <p className="muted">{state.body}</p>}
        </div>
        <footer className="modal-foot">
          <Button variant="ghost" onClick={() => onClose(false)}>
            Отмена
          </Button>
          <Button
            variant={state.danger ? "danger" : "primary"}
            onClick={() => onClose(true)}
          >
            {state.confirmText ?? "Подтвердить"}
          </Button>
        </footer>
      </div>
    </div>
  );
}
