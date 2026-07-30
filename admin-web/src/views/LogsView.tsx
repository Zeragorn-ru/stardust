import { useCallback, useEffect, useState } from "react";
import { api, ApiError } from "../api";
import type { ServerLogEntry } from "../types";
import { formatTelemetryTime } from "../format";

const labels: Record<string, string> = {
  external_mods: "Сторонние моды",
  join: "Вход на сервер",
  quit: "Выход с сервера",
  client_crash: "Краш клиента",
  server_crash: "Краш сервера",
};

export function LogsView({ mobile = false }: { mobile?: boolean }) {
  const [logs, setLogs] = useState<ServerLogEntry[]>([]);
  const [averageOnline, setAverageOnline] = useState<number | null>(null);
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
          <p className="muted">Запуски со сторонними модами, входы, выходы и краши за последние 30 дней.</p>
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
            <article className={`panel panel-flat log-card log-card--${log.eventType}`} key={log.id}>
              <div className="log-card__topline">
                <span className="log-card__type">{labels[log.eventType] ?? log.eventType}</span>
                <time>{formatTelemetryTime(log.recordedAt)}</time>
              </div>
              <strong className="log-card__summary">{log.summary}</strong>
              {log.username && <span className="log-card__user">Игрок: {log.username}</span>}
              {log.eventType === "external_mods" && <ExternalMods details={log.details} />}
              {log.eventType.endsWith("crash") && <CrashDetails details={log.details} />}
            </article>
          ))}
        </section>
      )}
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
