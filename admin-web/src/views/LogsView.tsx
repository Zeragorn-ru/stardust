import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError } from "../api";
import type { ServerLogEntry } from "../types";
import { formatTelemetryTime } from "../format";
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
  const [logs, setLogs] = useState<ServerLogEntry[]>([]);
  const [averageOnline, setAverageOnline] = useState<number | null>(null);
  const [selected, setSelected] = useState<ServerLogEntry | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setError(null);
      const response = await api.getServerLogs();
      setLogs(response.logs);
      setAverageOnline(response.averageOnline);
    } catch (reason) {
      setError(reason instanceof ApiError ? reason.message : "Не удалось загрузить журнал");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  return (
    <div className={`view logs-view${mobile ? " logs-view--mobile" : ""}`}>
      <header className="view-head page-head">
        <div>
          <span className="eyebrow">Server activity</span>
          <h1>Логи</h1>
          <p className="muted">Нажмите на событие, чтобы открыть полные данные и связанные файлы.</p>
        </div>
        <button className="secondary" type="button" onClick={() => void load()} disabled={loading}>Обновить</button>
      </header>

      {averageOnline !== null && (
        <section className="panel panel-flat logs-average-card">
          <span className="eyebrow">All-time server metric</span>
          <strong>{averageOnline.toFixed(1)}</strong>
          <small>средний онлайн за всё время</small>
        </section>
      )}

      {loading ? <p className="muted"><span className="spinner" /> Загрузка…</p> : error ? (
        <section className="panel panel-flat logs-empty"><strong>{error}</strong><button className="secondary" type="button" onClick={() => void load()}>Повторить</button></section>
      ) : logs.length === 0 ? (
        <section className="panel panel-flat logs-empty"><strong>Журнал пока пуст</strong><p className="muted">Новые события появятся после первого запуска клиента или входа игрока.</p></section>
      ) : (
        <section className="logs-list">
          {logs.map((log) => (
            <button className={`panel panel-flat log-card log-card--${log.eventType}`} key={log.id} type="button" onClick={() => setSelected(log)}>
              <span className="log-card__topline">
                <span className="log-card__type">{labels[log.eventType] ?? log.eventType}</span>
                <time>{formatTelemetryTime(log.recordedAt)}</time>
              </span>
              <strong className="log-card__summary">{log.summary}</strong>
              {log.username && <span className="log-card__user">Игрок: {log.username}</span>}
              {log.eventType === "external_mods" && <ExternalMods details={log.details} />}
              {log.eventType.endsWith("crash") && <CrashDetails details={log.details} />}
              <span className="log-card__open">Открыть детали →</span>
            </button>
          ))}
        </section>
      )}

      {selected && <LogDetails log={selected} onClose={() => setSelected(null)} />}
    </div>
  );
}

function ExternalMods({ details }: { details: Record<string, unknown> }) {
  const mods = Array.isArray(details.mods) ? details.mods : [];
  return <div className="log-card__details">Модов в отчёте: {mods.length}</div>;
}

function CrashDetails({ details }: { details: Record<string, unknown> }) {
  const error = typeof details.errorClass === "string" ? details.errorClass : null;
  const message = typeof details.message === "string" ? details.message : null;
  return error || message ? <div className="log-card__details">{error}{message ? `: ${message}` : ""}</div> : null;
}

function LogDetails({ log, onClose }: { log: ServerLogEntry; onClose: () => void }) {
  const files = log.eventType.endsWith("crash") ? crashFiles(log.details) : [];
  const mods = Array.isArray(log.details.mods) ? log.details.mods : [];
  const dialogRef = useRef<HTMLElement>(null);
  useDialogFocus(dialogRef, onClose);

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.currentTarget === event.target) onClose(); }}>
       <section ref={dialogRef} className="modal log-details-modal" role="dialog" aria-modal="true" aria-labelledby="log-details-title" tabIndex={-1}>
        <header className="log-details-head">
          <div>
            <span className="eyebrow">{labels[log.eventType] ?? log.eventType}</span>
            <h2 id="log-details-title">{log.summary}</h2>
            <small className="muted">{formatTelemetryTime(log.recordedAt)}{log.username ? ` · ${log.username}` : ""}</small>
          </div>
          <button className="icon-only" type="button" aria-label="Закрыть" onClick={onClose}>×</button>
        </header>

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
      </section>
    </div>
  );
}

function ExternalModRow({ mod }: { mod: unknown }) {
  const value = mod && typeof mod === "object" ? mod as Record<string, unknown> : {};
  const modId = typeof value.modId === "string" ? value.modId : typeof value.jarName === "string" ? value.jarName : "unknown";
  const jarName = typeof value.jarName === "string" ? value.jarName : modId;
  const sha256 = typeof value.sha256 === "string" ? value.sha256 : "";
  const [allowed, setAllowed] = useState(false);
  const [busy, setBusy] = useState(false);

  async function allow() {
    if (!sha256) return;
    setBusy(true);
    try { await api.allowExternalMod({ modId, jarName, sha256 }); setAllowed(true); } finally { setBusy(false); }
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
