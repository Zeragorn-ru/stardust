import { useState } from "react";
import type { UpdateInfo } from "../types";
import { installUpdate, onUpdateProgress } from "../api";

interface Props {
  /** Сведения об обнаруженном обновлении. */
  update: UpdateInfo;
  /** Закрыть всплывашку (отложить обновление). */
  onDismiss: () => void;
}

/**
 * Всплывашка с предложением обновиться. Показывается при старте, если
 * `check_update` нашёл новую версию. Установка переиспользует тот же поток,
 * что и в настройках: `installUpdate` качает установщик и перезапускает
 * приложение, поэтому промис при успехе может не завершиться.
 */
export default function UpdateModal({ update, onDismiss }: Props) {
  const [status, setStatus] = useState<"idle" | "installing" | "error">("idle");
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<number | null>(null);

  async function handleInstall() {
    setStatus("installing");
    setError(null);
    setProgress(null);
    const unlisten = await onUpdateProgress(setProgress);
    try {
      await installUpdate();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStatus("error");
    } finally {
      unlisten();
    }
  }

  const installing = status === "installing";
  const percent =
    progress != null
      ? Math.round(Math.min(Math.max(progress, 0), 1) * 100)
      : null;

  return (
    <div className="modal-overlay" onClick={installing ? undefined : onDismiss}>
      <div
        className="modal update-modal"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
      >
        <header className="modal__header">
          <h2>Доступно обновление</h2>
        </header>

        <div className="update-modal__body">
          <p>
            Версия <strong>{update.version}</strong> готова к установке. Текущая
            — {update.currentVersion}.
          </p>
          {update.notes && (
            <pre className="update-modal__notes">{update.notes}</pre>
          )}
          {installing && (
            <div className="update-modal__progress">
              <div className="progress">
                <div className="progress__track">
                  <div
                    className={
                      "progress__bar" +
                      (percent == null ? " progress__bar--indeterminate" : "")
                    }
                    style={
                      percent != null ? { width: `${percent}%` } : undefined
                    }
                  />
                </div>
              </div>
              <p className="muted">
                {percent != null ? `Загрузка ${percent}%` : "Загрузка…"}
              </p>
            </div>
          )}
          {error && <div className="alert alert--error">{error}</div>}
        </div>

        <footer className="modal__footer">
          <button
            type="button"
            className="btn btn--ghost"
            onClick={onDismiss}
            disabled={installing}
          >
            Позже
          </button>
          <button
            type="button"
            className="btn btn--primary"
            onClick={handleInstall}
            disabled={installing}
          >
            {installing ? "Обновление…" : "Обновить сейчас"}
          </button>
        </footer>
      </div>
    </div>
  );
}
