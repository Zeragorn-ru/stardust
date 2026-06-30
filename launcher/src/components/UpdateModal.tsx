import { useState } from "react";
import type { UpdateInfo, UpdateProgress } from "../types";
import { installUpdate, onUpdateProgress } from "../api";

interface Props {
  update: UpdateInfo;
  onDismiss: () => void;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} Б`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} КБ`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} МБ`;
}

function formatSpeed(bytesPerSec: number): string {
  if (bytesPerSec < 1024) return `${Math.round(bytesPerSec)} Б/с`;
  if (bytesPerSec < 1024 * 1024) return `${(bytesPerSec / 1024).toFixed(1)} КБ/с`;
  return `${(bytesPerSec / (1024 * 1024)).toFixed(1)} МБ/с`;
}

function formatEta(seconds: number): string {
  if (seconds < 60) return `~${Math.round(seconds)}с`;
  const min = Math.floor(seconds / 60);
  const sec = Math.round(seconds % 60);
  return sec > 0 ? `~${min}м ${sec}с` : `~${min}м`;
}

const PHASE_LABELS: Record<string, string> = {
  downloading_bootstrap: "Скачивание компонента обновления",
  downloading_installer: "Скачивание установщика",
  verifying_sha256: "Проверка целостности",
  launching: "Запуск обновления",
  error: "Ошибка",
};

const PHASE_ICONS: Record<string, string> = {
  downloading_bootstrap: "↓",
  downloading_installer: "↓",
  verifying_sha256: "✓",
  launching: "→",
  error: "✕",
};

function renderNotes(notes: string): string {
  return notes
    .split("\n")
    .map((line) => {
      const trimmed = line.trim();
      if (!trimmed) return "";
      if (/^[•\-*]\s/.test(trimmed)) {
        const content = trimmed.replace(/^[•\-*]\s+/, "");
        return `<li>${escapeHtml(content)}</li>`;
      }
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

  const installing = status === "installing";
  const fraction = progress?.fraction ?? null;
  const percent = fraction != null && Number.isFinite(fraction)
    ? Math.round(Math.min(Math.max(fraction, 0), 1) * 100)
    : null;
  const speed = progress?.speedBytesPerSec ?? null;
  const eta = progress?.etaSeconds ?? null;
  const downloaded = progress?.downloadedBytes ?? null;
  const total = progress?.totalBytes ?? null;
  const phaseKey = progress?.phase ?? null;
  const phaseLabel = phaseKey ? PHASE_LABELS[phaseKey] ?? phaseKey : null;
  const phaseIcon = phaseKey ? PHASE_ICONS[phaseKey] ?? "•" : null;

  return (
    <div className="update-overlay" onClick={installing ? undefined : onDismiss}>
      <div
        className="update-card"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
      >
        {/* Glow accent line removed — card background is the design */}

        {/* Header with version info */}
        <div className="update-card__header">
          <div className="update-card__icon-wrap">
            <div className="update-card__icon">↑</div>
          </div>
          <div className="update-card__title-group">
            <h2 className="update-card__title">Доступно обновление</h2>
            <p className="update-card__subtitle">
              <span className="update-card__ver-muted">{update.currentVersion}</span>
              <span className="update-card__ver-arrow">→</span>
              <span className="update-card__ver-new">{update.version}</span>
            </p>
          </div>
        </div>

        {/* Release notes */}
        {update.notes && (
          <div className="update-card__notes">
            <div className="update-card__notes-label">Что нового</div>
            <div
              className="update-card__notes-body"
              dangerouslySetInnerHTML={{ __html: renderNotes(update.notes) }}
            />
          </div>
        )}

        {/* Progress area */}
        {installing && (
          <div className="update-card__progress">
            <div className="update-card__progress-header">
              {phaseIcon && (
                <span className="update-card__phase-icon">{phaseIcon}</span>
              )}
              {phaseLabel && (
                <span className="update-card__phase-text">{phaseLabel}</span>
              )}
            </div>

            <div className="update-card__bar-track">
              <div
                className={
                  "update-card__bar-fill" +
                  (percent == null ? " update-card__bar-fill--indeterminate" : "")
                }
                style={percent != null ? { width: `${percent}%` } : undefined}
              />
            </div>

            <div className="update-card__meta">
              {percent != null && (
                <span className="update-card__meta-item update-card__meta-pct">
                  {percent}%
                </span>
              )}
              {speed != null && speed > 0 && (
                <span className="update-card__meta-item">{formatSpeed(speed)}</span>
              )}
              {eta != null && eta > 0 && (
                <span className="update-card__meta-item">{formatEta(eta)}</span>
              )}
              {downloaded != null && total != null && total > 0 && (
                <span className="update-card__meta-item update-card__meta-size">
                  {formatSize(downloaded)} / {formatSize(total)}
                </span>
              )}
            </div>
          </div>
        )}

        {/* Error */}
        {error && (
          <div className="update-card__error">
            <span className="update-card__error-icon">✕</span>
            <span>{error}</span>
          </div>
        )}

        {/* Actions */}
        <div className="update-card__actions">
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
              onClick={handleInstall}
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
        </div>
      </div>
    </div>
  );
}
