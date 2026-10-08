import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError } from "../api";
import type { ServerLogEntry, ServerLogSummary } from "../types";
import { formatTelemetryTime } from "../format";
import { IconSync } from "../ui/icons";
import { useToast } from "../ui/feedback";
import { useDialogFocus } from "../ui/useDialogFocus";

const labels: Record<string, string> = {
  external_mods: "Сторонние моды",
  external_mods_allowed: "Разрешенные сторонние моды",
  join: "Вход на сервер",
  quit: "Выход с сервера",
  client_crash: "Краш клиента",
  server_crash: "Краш сервера",
};

export function LogsView({ mobile = false }: { mobile?: boolean }) {
  const [logs, setLogs] = useState<ServerLogSummary[]>([]);
  const [averageOnline, setAverageOnline] = useState<number | null>(null);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  // Любой запрос списка в полёте: первый, ручной или фоновый.
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);

  const load = useCallback(async () => {
    // Защита от наложения запросов: интервал, возврат на вкладку и ручное
    // «Обновить» могут сработать подряд — второй запрос не стартует, пока
    // идёт первый, иначе поздний ответ перетёр бы свежий.
    if (inFlight.current) return;
    inFlight.current = true;
    setRefreshing(true);
    try {
      const response = await api.getServerLogs();
      setLogs(response.logs);
      setAverageOnline(response.averageOnline);
      // Ошибку сбрасываем только после успеха: иначе при неудачном фоне
      // список успевает мигнуть пустым состоянием между повторами.
      setError(null);
    } catch (reason) {
      setError(reason instanceof ApiError ? reason.message : "Нет соединения с сервером");
    } finally {
      inFlight.current = false;
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  // Автообновление раз в 30 секунд (как в обзорной панели). Скрытая вкладка
  // не опрашивается: таймер останавливается по visibilitychange, а при
  // возвращении журнал подтягивается сразу, чтобы не показывать устаревшее.
  useEffect(() => {
    const period = 30_000;
    let timer: number | undefined;
    const stop = () => {
      if (timer !== undefined) {
        window.clearInterval(timer);
        timer = undefined;
      }
    };
    const start = () => {
      if (timer === undefined) timer = window.setInterval(() => void load(), period);
    };
    function onVisibility() {
      if (document.hidden) {
        stop();
      } else {
        void load();
        start();
      }
    }
    document.addEventListener("visibilitychange", onVisibility);
    if (!document.hidden) start();
    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [load]);

  return (
    <div className={`view logs-view${mobile ? " logs-view--mobile" : ""}`}>
      <header className="view-head page-head">
        <div>
          <span className="eyebrow">Активность сервера</span>
          <h1>Логи</h1>
          <p className="muted">Нажмите на событие, чтобы открыть полные данные и связанные файлы.</p>
        </div>
        <button className="secondary" type="button" onClick={() => void load()} disabled={loading || refreshing}>
          <IconSync size={15} className={refreshing ? "spin" : ""} />
          {refreshing ? "Обновление…" : "Обновить"}
        </button>
      </header>

      {averageOnline !== null && (
        <section className="panel panel-flat logs-average-card">
          <span className="eyebrow">Статистика за всё время</span>
          <strong>{averageOnline.toFixed(1)}</strong>
          <small>средний онлайн за всё время</small>
        </section>
      )}

      {loading ? <p className="muted"><span className="spinner" /> Загрузка…</p> : error && logs.length === 0 ? (
        <section className="panel panel-flat logs-empty" role="alert">
          <strong>{error}</strong>
          <p className="muted">Проверьте соединение с сервером и попробуйте загрузить журнал снова.</p>
          <button className="secondary" type="button" onClick={() => void load()} disabled={refreshing}>Повторить</button>
        </section>
      ) : logs.length === 0 ? (
        <section className="panel panel-flat logs-empty">
          <strong>Журнал пока пуст</strong>
          <p className="muted">События появятся после первого запуска клиента или входа игрока и подтянутся автоматически.</p>
          <button className="secondary" type="button" onClick={() => void load()} disabled={refreshing}>Проверить сейчас</button>
        </section>
      ) : (
        <>
          {error && (
            // Фоновое обновление не удалось: показываем причину, не убирая список.
            <div className="logs-stale" role="alert">
              <strong>Не удалось обновить журнал</strong>
              <span className="muted">{error}</span>
              <button className="secondary" type="button" onClick={() => void load()} disabled={refreshing}>Повторить</button>
            </div>
          )}
          <section className="logs-list">
            {logs.map((log) => (
              <button
                className={`panel panel-flat log-card log-card--${log.eventType}`}
                key={log.id}
                type="button"
                onClick={() => setSelectedId(log.id)}
              >
                <span className="log-card__topline">
                  <span className="log-card__type">{labels[log.eventType] ?? log.eventType}</span>
                  <time>{formatTelemetryTime(log.recordedAt)}</time>
                </span>
                <strong className="log-card__summary">{log.summary}</strong>
                {log.username && <span className="log-card__user">Игрок: {log.username}</span>}
                <span className="log-card__open">Открыть детали →</span>
              </button>
            ))}
          </section>
        </>
      )}

      {selectedId !== null && <LogDetailsModal logId={selectedId} onClose={() => setSelectedId(null)} />}
    </div>
  );
}

function LogDetailsModal({ logId, onClose }: { logId: number; onClose: () => void }) {
  const [log, setLog] = useState<ServerLogEntry | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const dialogRef = useRef<HTMLElement>(null);
  useDialogFocus(dialogRef, onClose);

  // Детали грузятся при открытии диалога и по кнопке «Повторить».
  // Закрытый диалог не должен записывать состояние после ответа.
  useEffect(() => {
    let cancelled = false;
    setLog(null);
    setError(null);
    api.getServerLog(logId)
      .then((entry) => { if (!cancelled) setLog(entry); })
      .catch((reason) => {
        if (!cancelled) setError(reason instanceof ApiError ? reason.message : "Не удалось загрузить детали");
      });
    return () => { cancelled = true; };
  }, [logId, reload]);

  // Смена состояния (спиннер → ошибка → данные) может убрать из DOM
  // сфокусированную кнопку — фокус падает на body, и Escape с ловушкой Tab
  // из useDialogFocus перестают работать. После каждого рендера возвращаем
  // фокус внутрь диалога, если он сбежал.
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog || dialog.contains(document.activeElement)) return;
    const firstButton = dialog.querySelector<HTMLButtonElement>("button:not(:disabled)");
    (firstButton ?? dialog).focus();
  });

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.currentTarget === event.target) onClose(); }}>
      <section ref={dialogRef} className="modal log-details-modal" role="dialog" aria-modal="true" aria-label={log ? log.summary : "Детали события"} tabIndex={-1}>
        <header className="log-details-head">
          <div>
            {log ? (
              <>
                <span className="eyebrow">{labels[log.eventType] ?? log.eventType}</span>
                <h2>{log.summary}</h2>
                <small className="muted">{formatTelemetryTime(log.recordedAt)}{log.username ? ` · ${log.username}` : ""}</small>
              </>
            ) : (
              <span className="eyebrow">Детали события</span>
            )}
          </div>
          <button className="icon-only" type="button" aria-label="Закрыть" onClick={onClose}>×</button>
        </header>

        {!log && !error && <p className="muted log-details-state"><span className="spinner" /> Загружаем детали события…</p>}

        {error && (
          <div className="log-details-state" role="alert">
            <strong>{error}</strong>
            <button className="secondary" type="button" onClick={() => setReload((count) => count + 1)}>Повторить</button>
          </div>
        )}

        {log && <LogDetails log={log} />}
      </section>
    </div>
  );
}

function LogDetails({ log }: { log: ServerLogEntry }) {
  const files = log.eventType.endsWith("crash") ? crashFiles(log.details) : [];
  const mods = Array.isArray(log.details.mods) ? log.details.mods : [];

  return (
    <>
      {files.length > 0 && (
        <section className="log-details-section">
          <div className="log-details-section__head"><strong>Связанные файлы</strong><button className="secondary" type="button" onClick={() => downloadBundle(log, files)}>Скачать все</button></div>
          <div className="log-file-list">
            {files.map((file) => <button className="log-file" type="button" key={file.name} onClick={() => downloadText(file.name, file.content)}><span>{file.name}</span><small>Скачать</small></button>)}
          </div>
        </section>
      )}

      {mods.length > 0 && <section className="log-details-section"><strong>Сторонние моды</strong><div className="log-mod-list">{mods.map((mod, index) => <ExternalModRow key={index} mod={mod} />)}</div></section>}

      <section className="log-details-section"><strong>Полные данные события</strong><pre className="log-json">{JSON.stringify(log.details, null, 2)}</pre></section>
    </>
  );
}

function ExternalModRow({ mod }: { mod: unknown }) {
  const value = mod && typeof mod === "object" ? mod as Record<string, unknown> : {};
  const modId = typeof value.modId === "string" ? value.modId : typeof value.jarName === "string" ? value.jarName : "unknown";
  const jarName = typeof value.jarName === "string" ? value.jarName : modId;
  const sha256 = typeof value.sha256 === "string" ? value.sha256 : "";
  const [allowed, setAllowed] = useState(false);
  const [busy, setBusy] = useState(false);
  const toast = useToast();

  async function allow() {
    if (!sha256) return;
    setBusy(true);
    try {
      await api.allowExternalMod({ modId, jarName, sha256 });
      setAllowed(true);
      toast.success(`${jarName} разрешён`);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Не удалось разрешить мод");
    } finally {
      setBusy(false);
    }
  }

  return <div className="log-mod-row"><div><strong>{jarName}</strong><small>{modId} · <code>{sha256 || "hash отсутствует"}</code></small></div>{sha256 && <button className="secondary" type="button" disabled={busy || allowed} onClick={() => void allow()}>{allowed ? "Разрешен" : "Разрешить hash"}</button>}</div>;
}

function crashFiles(details: Record<string, unknown>): Array<{ name: string; content: string }> {
  const names: Array<[string, string]> = [["latest.log", "latestLog"], ["crash-report.txt", "crashReport"], ["debug.log", "debugLog"], ["launcher.log", "launcherLog"], ["stardust-mod.txt", "modReport"]];
  return names.flatMap(([name, key]) => typeof details[key] === "string" && details[key] ? [{ name, content: details[key] as string }] : []);
}

function downloadText(name: string, content: string) {
  const url = URL.createObjectURL(new Blob([content], { type: "text/plain;charset=utf-8" }));
  const anchor = document.createElement("a");
  anchor.href = url; anchor.download = name; anchor.click(); URL.revokeObjectURL(url);
}

function downloadBundle(log: ServerLogEntry, files: Array<{ name: string; content: string }>) {
  const content = [`Stardust crash bundle`, `Event: ${log.eventType}`, `Recorded: ${log.recordedAt}`, `Player: ${log.username ?? "unknown"}`, "", ...files.flatMap((file) => [`===== ${file.name} =====`, file.content, ""])].join("\n");
  downloadText(`stardust-crash-${log.id}.txt`, content);
}
