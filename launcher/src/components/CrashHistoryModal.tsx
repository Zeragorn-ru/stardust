import { useEffect, useMemo, useRef, useState } from "react";
import { crashHistory, type CrashHistoryEntry } from "../api";
import McText from "./McText";

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

/** Короткая подпись статуса записи: что с AI-разбором. */
function statusLabel(entry: CrashHistoryEntry): string | null {
  if (entry.aiStatus === "failed") return "разбор не удался";
  if (!entry.aiStatus) return "ждёт разбора";
  return null;
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

  const list = useMemo(() => entries ?? [], [entries]);

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
            {list.length > 0 && (
              <p className="muted crash-history__count">
                {list.length} {pluralEntries(list.length)}
              </p>
            )}
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
          <div className="crash-history__empty">
            <strong>Крашей пока не было</strong>
            <span className="muted">
              Если игра завершится аварийно, отчёт и разбор появятся здесь — даже
              после перезапуска лаунчера.
            </span>
          </div>
        )}

        {entries !== null && entries.length > 0 && (
          <ul className="crash-history__list">
            {entries.map((entry) => {
              const analysis = entry.aiAnalysis;
              const open = openId === entry.id;
              const severity = analysis?.severity ?? "";
              const status = statusLabel(entry);
              const resolved = Boolean(analysis && !analysis.error && severity);
              return (
                <li
                  key={entry.id}
                  className={`crash-history__item crash-history__item--${entry.aiStatus ?? "pending"}`}
                >
                  <button
                    type="button"
                    className="crash-history__row"
                    aria-expanded={open}
                    onClick={() => setOpenId(open ? null : entry.id)}
                  >
                    <span className="crash-history__head">
                      <span className="crash-history__date">{formatRecordedAt(entry.recordedAt)}</span>
                      {resolved ? (
                        <span className={`crash-history__sev crash-history__sev--${severity}`}>
                          {SEVERITY_LABELS[severity] ?? severity}
                        </span>
                      ) : status ? (
                        <span className="crash-history__status">{status}</span>
                      ) : null}
                      <span className="crash-history__chevron" aria-hidden>{open ? "▾" : "▸"}</span>
                    </span>
                    <span className="crash-history__summary">
                      <McText text={analysis?.summary || entry.summary} />
                    </span>
                  </button>
                  {open && (
                    <div className="crash-history__details">
                      {analysis?.summary && analysis.summary !== entry.summary && (
                        <p className="crash-history__raw"><span>Отчёт:</span> <McText text={entry.summary} /></p>
                      )}
                      {analysis?.cause && <p><span>Причина:</span> <McText text={analysis.cause} /></p>}
                      {analysis?.suggestion && <p><span>Что сделать:</span> <McText text={analysis.suggestion} /></p>}
                      {analysis?.error && <p><span>Ошибка разбора:</span> {analysis.error}</p>}
                      {!analysis && (
                        <p className="muted">
                          {entry.aiStatus === "failed"
                            ? "AI не смог разобрать этот краш. Полный отчёт остался у администраторов."
                            : "AI-вердикт ещё не готов — обновите список позже."}
                        </p>
                      )}
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

function pluralEntries(n: number): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return "запись";
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return "записи";
  return "записей";
}
