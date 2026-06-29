import { useState } from "react";
import type { UpdateInfo, UpdateProgress } from "../types";
import { installUpdate, onUpdateProgress } from "../api";

interface Props {
  /** Сведения об обнаруженном обновлении. */
  update: UpdateInfo;
  /** Закрыть всплывашку (отложить обновление). */
  onDismiss: () => void;
}

/** Форматирование размера в человекочитаемый вид. */
function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} Б`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} КБ`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} МБ`;
}

/** Форматирование скорости загрузки. */
function formatSpeed(bytesPerSec: number): string {
  if (bytesPerSec < 1024) return `${Math.round(bytesPerSec)} Б/с`;
  if (bytesPerSec < 1024 * 1024) return `${(bytesPerSec / 1024).toFixed(1)} КБ/с`;
  return `${(bytesPerSec / (1024 * 1024)).toFixed(1)} МБ/с`;
}

/** Форматирование ETA. */
function formatEta(seconds: number): string {
  if (seconds < 60) return `~${Math.round(seconds)}с`;
  const min = Math.floor(seconds / 60);
  const sec = Math.round(seconds % 60);
  return sec > 0 ? `~${min}м ${sec}с` : `~${min}м`;
}

/** Фазы обновления для отображения. */
const PHASE_LABELS: Record<string, string> = {
  downloading_bootstrap: "Скачивание компонента обновления",
  downloading_installer: "Скачивание установщика",
  verifying_sha256: "Проверка целостности",
  launching: "Запуск обновления",
  error: "Ошибка",
};

/** Парсинг простых markdown-списков в HTML. */
function renderNotes(notes: string): string {
  return notes
    .split("\n")
    .map((line) => {
      const trimmed = line.trim();
      if (!trimmed) return "";
      // Буллеты: строки начинающиеся с •, -, *
      if (/^[•\-*]\s/.test(trimmed)) {
        const content = trimmed.replace(/^[•\-*]\s+/, "");
        return `<li>${escapeHtml(content)}</li>`;
      }
      // Жирный: **текст**
      const escaped = escapeHtml(trimmed).replace(
        /\*\*(.+?)\*\*/g,
        "<strong>$1</strong>"
      );
      return `<p>${escaped}</p>`;
    })
    .filter((l) => l)
    .join("\n");
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
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
  const [progress, setProgress] = useState<UpdateProgress | null>(null);

  async function handleInstall() {
    setStatus("installing");
    setError(null);
    setProgress(null);
    const unlisten = await onUpdateProgress((p) => {
      setProgress(p);
      if (p.phase === "error") {
        setError(p.label);
        setStatus("error");
      }
    });
    try {
      await installUpdate();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStatus("error");
    } finally {
      unlisten();
    }
  }

  function handleRetry() {
    handleInstall();
  }

  const installing = status === "installing";
  const fraction = progress?.fraction ?? null;
  const percent = fraction != null && Number.isFinite(fraction) ? Math.round(Math.min(Math.max(fraction, 0), 1) * 100) : null;
  const speed = progress?.speedBytesPerSec ?? null;
  const eta = progress?.etaSeconds ?? null;
  const downloaded = progress?.downloadedBytes ?? null;
  const total = progress?.totalBytes ?? null;
  const phaseLabel = progress?.phase ? PHASE_LABELS[progress.phase] ?? progress.phase : null;

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
          <p className="update-modal__version">
            <span className="update-modal__version-old">{update.currentVersion}</span>
            <span className="update-modal__version-arrow">→</span>
            <span className="update-modal__version-new">{update.version}</span>
          </p>

          {update.notes && (
            <div className="update-modal__notes">
              <div className="update-modal__notes-title">Что нового</div>
              <div
                className="update-modal__notes-content"
                dangerouslySetInnerHTML={{ __html: renderNotes(update.notes) }}
              />
            </div>
          )}

          {installing && (
            <div className="update-modal__progress">
              {phaseLabel && (
                <div className="update-modal__phase">{phaseLabel}</div>
              )}

              <div className="progress">
                <div className="progress__track">
                  <div
                    className={
                      "progress__bar" +
                      (percent == null ? " progress__bar--indeterminate" : "")
                    }
                    style={percent != null ? { width: `${percent}%` } : undefined}
                  />
                </div>
              </div>

              <div className="update-modal__stats">
                {percent != null && <span>{percent}%</span>}
                {speed != null && speed > 0 && <span>{formatSpeed(speed)}</span>}
                {eta != null && eta > 0 && <span>{formatEta(eta)}</span>}
              </div>

              {downloaded != null && total != null && total > 0 && (
                <div className="update-modal__size">
                  {formatSize(downloaded)} / {formatSize(total)}
                </div>
              )}
            </div>
          )}

          {error && (
            <div className="update-modal__error">
              <p>{error}</p>
            </div>
          )}
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
          {status === "error" ? (
            <button
              type="button"
              className="btn btn--primary"
              onClick={handleRetry}
            >
              Повторить
            </button>
          ) : (
            <button
              type="button"
              className="btn btn--primary"
              onClick={handleInstall}
              disabled={installing}
            >
              {installing ? "Обновление…" : "Обновить"}
            </button>
          )}
        </footer>
      </div>
    </div>
  );
}
