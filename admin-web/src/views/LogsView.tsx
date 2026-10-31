import { useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { api, ApiError } from "../api";
import type { CrashAiAnalysis, ServerLogEntry, ServerLogSummary } from "../types";
import { formatTelemetryTime } from "../format";
import { IconSync } from "../ui/icons";
import { McText } from "../ui/McText";
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

/** Вкладки-фильтры по eventType (план 3.7): «Все» + известные типы. */
const FILTER_TABS: Array<{ value: string; label: string }> = [
  { value: "all", label: "Все события" },
  ...Object.entries(labels).map(([value, label]) => ({ value, label })),
];

export function LogsView({ mobile = false }: { mobile?: boolean }) {
  const [logs, setLogs] = useState<ServerLogSummary[]>([]);
  const [averageOnline, setAverageOnline] = useState<number | null>(null);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  // Любой запрос списка в полёте: первый, ручной или фоновый.
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);

  // Глубокая ссылка ?type=external_mods (план 3.7): фильтр живёт в query,
  // поэтому ссылкой можно поделиться и она переживает перезагрузку.
  // Мобильный шелл — вне data-роутера: useSearchParams там недоступен,
  // поэтому на mobile читаем window.location.search напрямую.
  const [searchParams, setSearchParams] = useSearchParams();
  const [mobileType, setMobileType] = useState<string>(() =>
    new URLSearchParams(window.location.search).get("type") ?? "all",
  );
  const typeFilter = mobile
    ? mobileType
    : searchParams.get("type") ?? "all";

  const setTypeFilter = useCallback((value: string) => {
    if (mobile) {
      setMobileType(value);
      return;
    }
    setSearchParams((params) => {
      if (value === "all") params.delete("type");
      else params.set("type", value);
      return params;
    });
  }, [mobile, setSearchParams]);

  // Фильтрация локальная: журнал уже загружен целиком, вкладка меняет
  // только видимый срез — без повторного запроса.
  const visibleLogs = typeFilter === "all"
    ? logs
    : logs.filter((log) => log.eventType === typeFilter);

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

      {/* Вкладки-фильтры по eventType (план 3.7). На фильтре считаем,
          сколько событий в срезе, чтобы пустая вкладка была предсказуема. */}
      <div className="logs-tabs seg" role="tablist" aria-label="Фильтр по типу события">
        {FILTER_TABS.map((tab) => (
          <button
            key={tab.value}
            type="button"
            role="tab"
            aria-selected={typeFilter === tab.value}
            className={`seg-btn${typeFilter === tab.value ? " active" : ""}`}
            onClick={() => setTypeFilter(tab.value)}
          >
            {tab.label}
          </button>
        ))}
      </div>

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
      ) : visibleLogs.length === 0 ? (
        <section className="panel panel-flat logs-empty">
          <strong>Событий этого типа пока нет</strong>
          <p className="muted">На вкладке «Все события» видно весь журнал целиком.</p>
          <button className="secondary" type="button" onClick={() => setTypeFilter("all")}>Показать все</button>
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
            {visibleLogs.map((log) => (
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
                {/* Summary и ник — контент игрока: эмодзи рисуем глифами McEmoji. */}
                <strong className="log-card__summary"><McText text={log.summary} /></strong>
                {log.username && <span className="log-card__user">Игрок: <McText text={log.username} /></span>}
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
                <h2><McText text={log.summary} /></h2>
                <small className="muted">
                  {formatTelemetryTime(log.recordedAt)}
                  {log.username && <> · <McText text={log.username} /></>}
                </small>
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

        {log && <LogDetails log={log} onAnalyzed={() => setReload((n) => n + 1)} />}
      </section>
    </div>
  );
}

function LogDetails({ log, onAnalyzed }: { log: ServerLogEntry; onAnalyzed: () => void }) {
  const isCrash = log.eventType.endsWith("crash");
  const files = isCrash ? crashFiles(log.details) : [];
  const mods = Array.isArray(log.details.mods) ? log.details.mods : [];

  return (
    <>
      {isCrash && <CrashAiSection log={log} onAnalyzed={onAnalyzed} />}

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

/** Русские подписи уровней серьёзности вердикта. */
const SEVERITY_LABELS: Record<string, string> = {
  low: "низкая",
  medium: "средняя",
  high: "высокая",
  critical: "критическая",
};

/**
 * AI-разбор краша: показывает вердикт (done), ошибку (failed), спиннер
 * (pending) или кнопку запуска. `onAnalyzed` перезагружает запись после
 * ручного анализа, чтобы подтянуть свежий вердикт с бэкенда.
 */
function CrashAiSection({ log, onAnalyzed }: { log: ServerLogEntry; onAnalyzed: () => void }) {
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const verdict: CrashAiAnalysis | undefined = log.aiAnalysis;

  async function analyze() {
    setBusy(true);
    try {
      await api.analyzeServerLog(log.id);
      onAnalyzed();
      toast.success("AI-разбор готов");
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Не удалось проанализировать краш");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="log-details-section">
      <div className="log-details-section__head">
        <strong>AI-разбор краша</strong>
        <button
          className="secondary"
          type="button"
          disabled={busy}
          onClick={() => void analyze()}
        >
          {busy ? "Анализ…" : verdict ? "Пересчитать" : "Проанализировать"}
        </button>
      </div>

      {verdict && verdict.error && (
        <div className="log-details-state" role="alert">
          <strong>Анализ не удался</strong>
          <span className="muted">{verdict.error}</span>
        </div>
      )}

      {verdict && !verdict.error && (
        <div className="crash-ai">
          <span className={`crash-ai__sev crash-ai__sev--${verdict.severity ?? "medium"}`}>
            {SEVERITY_LABELS[verdict.severity ?? ""] ?? "средняя"}
          </span>
          <p className="crash-ai__summary">{verdict.summary}</p>
          <dl className="crash-ai__grid">
            <div><dt>Причина</dt><dd>{verdict.cause || "—"}</dd></div>
            <div><dt>Что сделать</dt><dd>{verdict.suggestion || "—"}</dd></div>
          </dl>
          <small className="muted">
            {verdict.model ? `Модель: ${verdict.model}` : "AI"}
            {verdict.analyzedAt ? ` · ${formatTelemetryTime(verdict.analyzedAt)}` : ""}
          </small>
        </div>
      )}

      {!verdict && (
        <p className="muted">
          Автоматический разбор ещё не обработал запись (или выключен в настройках).
          Нажмите «Проанализировать», чтобы отправить краш в настроенный AI-провайдер.
        </p>
      )}
    </section>
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
