import { useEffect, useRef, useState } from "react";
import { crashHistory, type CrashHistoryEntry } from "../api";

const SEVERITY_LABELS: Record<string, string> = {
  low: "низкая",
  medium: "средняя",
  high: "высокая",
  critical: "критическая",
};

/** «29.10 01:24» — дата и время краша по-русски, без года для текущего. */
function formatRecordedAt(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const day = String(d.getDate()).padStart(2, "0");
  const mon = String(d.getMonth() + 1).padStart(2, "0");
  const time = d.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
  const yearPart = d.getFullYear() !== new Date().getFullYear() ? `.${d.getFullYear()}` : "";
  return `${day}.${mon}${yearPart} ${time}`;
}

/**
 * История крашей игрока с сервера: дата, сводка и AI-вердикт (если готов).
 * Данные живут на сервере, поэтому список доступен и после закрытия
 * лаунчера, и на другой машине. Раскрывающаяся запись показывает причину
 * и рекомендацию — то же, что во всплывашке, но без спешки.
 */
export default function CrashHistoryModal({ onClose }: { onClose: () => void }) {
  const [entries, setEntries] = useState<CrashHistoryEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [openId, setOpenId] = useState<number | null>(null);
  const dialogRef = useRef<HTMLElement>(null);

  useEffect(() => {
    let cancelled = false;
    crashHistory()
      .then((list) => { if (!cancelled) setEntries(list); })
      .catch((reason) => {
        if (!cancelled) setError(reason instanceof Error ? reason.message : "Не удалось загрузить историю");
      });
    return () => { cancelled = true; };
  }, []);

  // Escape закрывает; фокус держим внутри диалога.
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    dialogRef.current?.focus();
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      className="modal-overlay"
      onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}
    >
      <section
        ref={dialogRef}
        className="modal crash-history-modal"
        role="dialog"
        aria-modal="true"
        aria-label="История крашей"
        tabIndex={-1}
        onClick={(event) => event.stopPropagation()}
      >
        <header className="modal__header">
          <div>
            <h2>История крашей</h2>
          </div>
          <button type="button" className="btn btn--icon" onClick={onClose} aria-label="Закрыть">
            ✕
          </button>
        </header>

        {entries === null && !error && (
          <p className="muted crash-history__state"><span className="spinner" /> Загружаем историю…</p>
        )}
        {error && (
          <p className="muted crash-history__state" role="alert">{error}</p>
        )}
        {entries !== null && entries.length === 0 && (
          <p className="muted crash-history__state">
            Крашей пока не было — или лаунчер ещё не отправлял отчёты на сервер.
          </p>
        )}

        {entries !== null && entries.length > 0 && (
          <ul className="crash-history__list">
            {entries.map((entry) => {
              const analysis = entry.aiAnalysis;
              const open = openId === entry.id;
              const severity = analysis?.severity ?? "";
              return (
                <li key={entry.id} className={`crash-history__item crash-history__item--${entry.aiStatus ?? "pending"}`}>
                  <button
                    type="button"
                    className="crash-history__row"
                    aria-expanded={open}
                    onClick={() => setOpenId(open ? null : entry.id)}
                  >
                    <span className="crash-history__date">{formatRecordedAt(entry.recordedAt)}</span>
                    <span className="crash-history__summary">{entry.summary}</span>
                    {analysis && !analysis.error && severity && (
                      <span className={`crash-history__sev crash-history__sev--${severity}`}>
                        {SEVERITY_LABELS[severity] ?? severity}
                      </span>
                    )}
                    {entry.aiStatus === "failed" && (
                      <span className="crash-history__sev crash-history__sev--failed">разбор не удался</span>
                    )}
                    {!entry.aiStatus && <span className="crash-history__sev">ждёт разбора</span>}
                    <span className="crash-history__chevron" aria-hidden>{open ? "▾" : "▸"}</span>
                  </button>
                  {open && (
                    <div className="crash-history__details">
                      {analysis?.summary && <p>{analysis.summary}</p>}
                      {analysis?.cause && <p><span>Причина:</span> {analysis.cause}</p>}
                      {analysis?.suggestion && <p><span>Что сделать:</span> {analysis.suggestion}</p>}
                      {analysis?.error && <p><span>Ошибка разбора:</span> {analysis.error}</p>}
                      {!analysis && <p className="muted">AI-вердикт ещё не готов.</p>}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}
