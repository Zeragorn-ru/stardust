import { useCallback, useEffect, useState } from "react";
import { readLogTail } from "../api";

export interface LogTab {
  id: string;
  label: string;
  path: string;
}

interface Props {
  title: string;
  tabs: LogTab[];
  initialTabId?: string;
  onClose: () => void;
}

export default function LogViewerModal({
  title,
  tabs,
  initialTabId,
  onClose,
}: Props) {
  const [activeTabId, setActiveTabId] = useState(
    initialTabId ?? tabs[0]?.id ?? "",
  );
  const [lines, setLines] = useState<string[]>([]);
  const [path, setPath] = useState("");
  const [truncated, setTruncated] = useState(false);
  const [exists, setExists] = useState(true);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [autoRefresh, setAutoRefresh] = useState(false);

  const activeTab = tabs.find((t) => t.id === activeTabId) ?? tabs[0];

  const refresh = useCallback(async () => {
    if (!activeTab) return;
    setLoading(true);
    setError(null);
    try {
      const tail = await readLogTail(activeTab.path, 300);
      setLines(tail.lines);
      setPath(tail.path);
      setTruncated(tail.truncated);
      setExists(tail.exists);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setLines([]);
    } finally {
      setLoading(false);
    }
  }, [activeTab]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (!autoRefresh) return;
    const id = setInterval(() => {
      void refresh();
    }, 3000);
    return () => clearInterval(id);
  }, [autoRefresh, refresh]);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        className="modal log-viewer-modal"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
      >
        <header className="modal__header log-viewer-modal__header">
          <div>
            <span className="log-viewer-modal__eyebrow">Логи</span>
            <h2>{title}</h2>
          </div>
          <button
            type="button"
            className="btn btn--icon"
            onClick={onClose}
            aria-label="Закрыть"
          >
            ✕
          </button>
        </header>

        {tabs.length > 1 && (
          <div className="log-viewer-modal__tabs" role="tablist">
            {tabs.map((tab) => (
              <button
                key={tab.id}
                type="button"
                role="tab"
                aria-selected={tab.id === activeTabId}
                className={
                  "log-viewer-modal__tab" +
                  (tab.id === activeTabId ? " log-viewer-modal__tab--active" : "")
                }
                onClick={() => setActiveTabId(tab.id)}
              >
                {tab.label}
              </button>
            ))}
          </div>
        )}

        <div className="log-viewer-modal__toolbar">
          <button
            type="button"
            className="btn btn--ghost"
            onClick={() => void refresh()}
            disabled={loading}
          >
            {loading ? "Обновление…" : "Обновить"}
          </button>
          <label className="log-viewer-modal__auto">
            <input
              type="checkbox"
              checked={autoRefresh}
              onChange={(e) => setAutoRefresh(e.target.checked)}
            />
            Автообновление
          </label>
        </div>

        {path && (
          <div className="log-viewer-modal__path muted" title={path}>
            {path}
          </div>
        )}

        {error && <p className="log-viewer-modal__error">{error}</p>}

        <div className="log-viewer-modal__body">
          {!exists && !loading && !error && (
            <p className="muted log-viewer-modal__empty">
              Файл пока не создан. Запустите игру или повторите попытку позже.
            </p>
          )}
          {lines.length > 0 ? (
            <pre className="log-viewer-modal__pre">
              {lines.join("\n")}
            </pre>
          ) : exists && !loading && !error ? (
            <p className="muted log-viewer-modal__empty">Файл пуст.</p>
          ) : null}
          {truncated && (
            <p className="muted log-viewer-modal__truncated">
              Показан конец файла (файл обрезан для безопасности).
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
