import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { crashHistory, type CrashHistoryEntry } from "../api";
import CrashVerdictBody, { SEVERITY_LABELS } from "./CrashVerdictBody";
import McText from "./McText";

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
 * Текст ошибки Tauri-команды: команды возвращают `Result<_, String>`, поэтому
 * отказ приходит строкой, а не `Error`, — `instanceof Error` его бы потерял.
 */
function errorMessage(reason: unknown): string {
  if (reason instanceof Error) return reason.message;
  if (typeof reason === "string" && reason.trim()) return reason;
  return "Не удалось загрузить историю";
}

/** Короткая подпись статуса записи: что с AI-разбором. */
function statusLabel(entry: CrashHistoryEntry): string | null {
  if (entry.aiStatus === "failed") return "разбор не удался";
  // «pending» — сервер уже разбирает прямо сейчас, вердикт придёт опросом
  // сразу после краша. Остальные значения (чаще всего null при выключенном
  // AI) разбора не ждут вовсе: обещать «ждёт разбора» там нельзя.
  if (entry.aiStatus === "pending") return "разбираем…";
  return null;
}

/**
 * Что показать в раскрытой записи, если вердикта нет. Для `pending` — честное
 * «скоро»; для `failed` — ошибку разбора; для `null` (AI выключен на сервере)
 * — что разбора не будет, иначе игрок будет ждать его вечно.
 */
function pendingText(entry: CrashHistoryEntry): string {
  if (entry.aiStatus === "failed") {
    return "AI не смог разобрать этот краш. Полный отчёт остался у администраторов.";
  }
  if (entry.aiStatus === "pending") {
    return "AI-вердикт ещё не готов — обычно это занимает несколько секунд после краша.";
  }
  // Статуса нет, если AI был выключен при отправке. Не утверждаем, что
  // разбора не будет никогда: включённый позже AI подхватит свежие краши
  // фоновым воркером (до 7 дней).
  return "AI-разбор при отправке не запускался. Полный отчёт остался у администраторов.";
}

function pluralEntries(n: number): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return "запись";
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return "записи";
  return "записей";
}

/**
 * Содержимое истории крашей: загрузка, список с раскрывающимися AI-вердиктами.
 * Живёт и в собственной модалке, и во вкладке «Краши» модалки сборки —
 * скролл отдаём списку, сама панель растягивается на всю высоту контейнера.
 */
export function CrashHistoryPanel() {
  const [entries, setEntries] = useState<CrashHistoryEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [openId, setOpenId] = useState<number | null>(null);
  // Номер текущего запроса: ответ устаревшего повтора не должен перезаписать
  // свежий результат, а ответ после закрытия — тронуть состояние.
  const requestSeq = useRef(0);

  const load = useCallback(() => {
    const seq = ++requestSeq.current;
    setEntries(null);
    setError(null);
    crashHistory()
      .then((list) => { if (seq === requestSeq.current) setEntries(list); })
      .catch((reason) => {
        if (seq === requestSeq.current) setError(errorMessage(reason));
      });
  }, []);

  useEffect(() => {
    load();
    return () => { requestSeq.current += 1; };
  }, [load]);

  const list = useMemo(() => entries ?? [], [entries]);

  return (
    <div className="crash-history__panel">
      {list.length > 0 && (
        <p className="muted crash-history__count">
          {list.length} {pluralEntries(list.length)}
        </p>
      )}

      {entries === null && !error && (
        <p className="muted crash-history__state"><span className="spinner" /> Загружаем историю…</p>
      )}
      {error && (
        <div className="crash-history__empty" role="alert">
          <strong>{error}</strong>
          <button type="button" className="btn btn--ghost" onClick={load}>
            Попробовать снова
          </button>
        </div>
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
            // Пока идёт разбор, сервер кладёт пустой объект — для показа это
            // то же, что вердикта нет.
            const analysis = entry.aiAnalysis && Object.keys(entry.aiAnalysis).length > 0
              ? entry.aiAnalysis
              : undefined;
            const open = openId === entry.id;
            const severity = analysis?.severity ?? "";
            const status = statusLabel(entry);
            const resolved = Boolean(analysis && !analysis.error && severity);
            return (
              <li
                key={entry.id}
                className={`crash-history__item crash-history__item--${entry.aiStatus ?? "none"}`}
              >
                <button
                  type="button"
                  className="crash-history__row"
                  aria-expanded={open}
                  onClick={() => setOpenId(open ? null : entry.id)}
                >
                  <span className="crash-history__rowbox">
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
                  </span>
                </button>
                {open && (
                  <div className="crash-history__details">
                    {analysis && !analysis.error && (
                      <CrashVerdictBody
                        summary={analysis.summary}
                        cause={analysis.cause}
                        suggestion={analysis.suggestion}
                        rawReport={entry.summary}
                      />
                    )}
                    {analysis?.error && (
                      <>
                        <p className="muted">
                          AI не смог разобрать этот краш. Полный отчёт остался у администраторов.
                        </p>
                        <details className="crash-verdict__more">
                          <summary>Технические подробности</summary>
                          <p>{analysis.error}</p>
                        </details>
                      </>
                    )}
                    {!analysis && (
                      <p className="muted">{pendingText(entry)}</p>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/**
 * История крашей игрока с сервера: дата, сводка и AI-вердикт (если готов).
 * Данные живут на сервере, поэтому список доступен и после закрытия
 * лаунчера, и на другой машине. Раскрывающаяся запись показывает причину
 * и рекомендацию — то же, что во всплывашке, но без спешки.
 */
export default function CrashHistoryModal({ onClose }: { onClose: () => void }) {
  const dialogRef = useRef<HTMLElement>(null);

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
          <h2>История крашей</h2>
          <button type="button" className="btn btn--icon" onClick={onClose} aria-label="Закрыть">
            ✕
          </button>
        </header>
        <CrashHistoryPanel />
      </section>
    </div>
  );
}
