import { useCallback, useEffect, useRef, useState } from "react";
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
  const [followEnd, setFollowEnd] = useState(true);
  const [wrapLines, setWrapLines] = useState(true);
  const [query, setQuery] = useState("");
  const [matchCursor, setMatchCursor] = useState(-1);
  const [copyStatus, setCopyStatus] = useState<"idle" | "copied" | "error">("idle");
  const bodyRef = useRef<HTMLDivElement>(null);
  const lineRefs = useRef<Array<HTMLSpanElement | null>>([]);

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
    if (!followEnd || lines.length === 0) return;
    const frame = window.requestAnimationFrame(() => {
      const body = bodyRef.current;
      if (body) body.scrollTop = body.scrollHeight;
    });
    return () => window.cancelAnimationFrame(frame);
  }, [followEnd, lines]);

  const normalizedQuery = query.trim().toLocaleLowerCase();
  const matchIndexes = normalizedQuery
    ? lines.reduce<number[]>((matches, line, index) => {
        if (line.toLocaleLowerCase().includes(normalizedQuery)) matches.push(index);
        return matches;
      }, [])
    : [];

  useEffect(() => {
    setMatchCursor(matchIndexes.length > 0 ? 0 : -1);
  }, [normalizedQuery, lines]);

  useEffect(() => {
    if (matchCursor < 0) return;
    const lineIndex = matchIndexes[matchCursor];
    lineRefs.current[lineIndex]?.scrollIntoView({ block: "center" });
  }, [matchCursor, matchIndexes]);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  function moveMatch(direction: 1 | -1) {
    if (matchIndexes.length === 0) return;
    setMatchCursor((current) =>
      current < 0
        ? 0
        : (current + direction + matchIndexes.length) % matchIndexes.length,
    );
  }

  async function copyLog() {
    try {
      await navigator.clipboard.writeText(lines.join("\n"));
      setCopyStatus("copied");
    } catch {
      setCopyStatus("error");
    }
  }

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
          <div className="log-viewer-modal__toolbar-actions">
            <button
              type="button"
              className="btn btn--ghost"
              onClick={() => void refresh()}
              disabled={loading}
            >
              {loading ? "Обновление…" : "Обновить"}
            </button>
            <button
              type="button"
              className="btn btn--ghost"
              onClick={() => void copyLog()}
              disabled={lines.length === 0}
            >
              {copyStatus === "copied"
                ? "Скопировано"
                : copyStatus === "error"
                  ? "Не удалось скопировать"
                  : "Копировать"}
            </button>
          </div>
          <div className="log-viewer-modal__options">
            <label className="log-viewer-modal__auto">
              <input
                type="checkbox"
                checked={autoRefresh}
                onChange={(e) => setAutoRefresh(e.target.checked)}
              />
              Автообновление
            </label>
            <label className="log-viewer-modal__auto">
              <input
                type="checkbox"
                checked={followEnd}
                onChange={(e) => setFollowEnd(e.target.checked)}
              />
              В конец файла
            </label>
            <label className="log-viewer-modal__auto">
              <input
                type="checkbox"
                checked={wrapLines}
                onChange={(e) => setWrapLines(e.target.checked)}
              />
              Перенос строк
            </label>
          </div>
        </div>

        <div className="log-viewer-modal__filter">
          <input
            type="search"
            className="input"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setCopyStatus("idle");
            }}
            placeholder="Поиск по логу…"
            aria-label="Поиск по логу"
          />
          {normalizedQuery && (
            <span className="muted log-viewer-modal__match-count">
              {matchIndexes.length > 0 ? `${matchCursor + 1} / ${matchIndexes.length}` : "Нет совпадений"}
            </span>
          )}
          <button
            type="button"
            className="btn btn--ghost"
            onClick={() => moveMatch(-1)}
            disabled={matchIndexes.length === 0}
            aria-label="Предыдущее совпадение"
          >
            ↑
          </button>
          <button
            type="button"
            className="btn btn--ghost"
            onClick={() => moveMatch(1)}
            disabled={matchIndexes.length === 0}
            aria-label="Следующее совпадение"
          >
            ↓
          </button>
        </div>

        {path && (
          <div className="log-viewer-modal__path muted" title={path}>
            {path}
          </div>
        )}

        {error && <p className="log-viewer-modal__error">Не удалось обновить лог: {error}</p>}

        <div
          className="log-viewer-modal__body"
          ref={bodyRef}
          onScroll={(event) => {
            const body = event.currentTarget;
            setFollowEnd(body.scrollHeight - body.scrollTop - body.clientHeight <= 2);
          }}
        >
          {!exists && !loading && !error && (
            <p className="muted log-viewer-modal__empty">
              Файл пока не создан. Запустите игру или повторите попытку позже.
            </p>
          )}
          {lines.length > 0 ? (
            <pre className={"log-viewer-modal__pre" + (wrapLines ? "" : " log-viewer-modal__pre--nowrap")}>
              {lines.map((line, index) => (
                <span
                  key={`${index}-${line}`}
                  ref={(element) => { lineRefs.current[index] = element; }}
                  className={
                    "log-viewer-modal__line" +
                    (matchIndexes[matchCursor] === index ? " log-viewer-modal__line--active" : "") +
                    (normalizedQuery && line.toLocaleLowerCase().includes(normalizedQuery)
                      ? " log-viewer-modal__line--match"
                      : "")
                  }
                >
                  {line}{"\n"}
                </span>
              ))}
            </pre>
          ) : exists && !loading && !error ? (
            <p className="muted log-viewer-modal__empty">
              Файл пуст.
            </p>
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
