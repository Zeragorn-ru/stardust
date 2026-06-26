// Тосты (всплывающие уведомления) и модальное подтверждение.
//
// Заменяют браузерные alert()/confirm() и разрозненные inline-ошибки:
// единая точка для коротких сообщений об успехе/ошибке и для опасных
// действий вроде удаления. Оборачивает приложение одним провайдером.

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

  const dismiss = useCallback((id: number) => {
    setToasts((list) => list.filter((t) => t.id !== id));
  }, []);

  const push = useCallback(
    (kind: ToastKind, text: string) => {
      const id = nextId.current++;
      setToasts((list) => [...list, { id, kind, text }]);
      // Ошибки висят дольше, чтобы успеть прочитать.
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
              role="status"
            >
              {t.text}
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
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose(false);
      if (e.key === "Enter") onClose(true);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="modal-backdrop" onClick={() => onClose(false)}>
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        onClick={(e) => e.stopPropagation()}
      >
        <h3>{state.title}</h3>
        {state.body && <p className="muted">{state.body}</p>}
        <div className="modal-actions">
          <button onClick={() => onClose(false)} autoFocus>
            Отмена
          </button>
          <button
            className={state.danger ? "danger-solid" : "primary"}
            onClick={() => onClose(true)}
          >
            {state.confirmText ?? "Подтвердить"}
          </button>
        </div>
      </div>
    </div>
  );
}
