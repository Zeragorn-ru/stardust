// EventsView — единый журнал событий сервера (admin-v2, этап 3).
//
// Данные — getServerLogs (сводки за последние 30 дней, лимит 500).
// Фильтры клиентские: API умеет только «срез 30 дней», поэтому окно времени,
// тип события и игрок фильтруются на месте.
//
// AI-анализ крашей: в сводках (ServerLogSummary) aiStatus нет — он есть
// только в полной записи (getServerLog). Поэтому для краш-записей докачиваем
// детали и держим статус/вердикт в отдельной карте по id. «Разобрать AI»
// вызывает analyzeServerLog и обновляет карту по ответу.

import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "../api";
import type { CrashAiAnalysis, ServerLogSummary } from "../types";
import { LogTable, SectionCard, Segmented, Select } from "../ui/kit";
import type { LogRow } from "../ui/kit";

type EventTypeFilter = "all" | "join" | "quit" | "client_crash" | "server_crash" | "external_mods";
type TimeFilter = "24h" | "7d" | "30d" | "all";

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

const TIME_OPTIONS: { value: TimeFilter; label: string; hint?: string }[] = [
  { value: "24h", label: "24 часа" },
  { value: "7d", label: "7 дней" },
  { value: "30d", label: "30 дней" },
  { value: "all", label: "Всё", hint: "API отдаёт максимум 30 дней сводок" },
];

const EVENT_TYPE_OPTIONS: { value: EventTypeFilter; label: string }[] = [
  { value: "all", label: "Все события" },
  { value: "join", label: "Входы" },
  { value: "quit", label: "Выходы" },
  { value: "client_crash", label: "Крахи клиента" },
  { value: "server_crash", label: "Крахи сервера" },
  { value: "external_mods", label: "Чужие моды" },
];

function eventTypeMeta(eventType: string): { label: string; state: LogRow["state"] } {
  switch (eventType) {
    case "join":
      return { label: "Вход", state: "ok" };
    case "quit":
      return { label: "Выход", state: "muted" };
    case "client_crash":
      return { label: "Крах клиента", state: "bad" };
    case "server_crash":
      return { label: "Крах сервера", state: "bad" };
    case "external_mods":
      return { label: "Чужие моды", state: "warn" };
    default:
      return { label: eventType, state: "muted" };
  }
}

function isCrash(eventType: string): boolean {
  return eventType === "client_crash" || eventType === "server_crash";
}

/** Бейдж AI-статуса краша в ячейке «Событие». */
function AiBadge({ status }: { status: "pending" | "done" | "failed" | "none" }) {
  switch (status) {
    case "done":
      return <span className="kit-badge kit-badge--ok">AI: есть вердикт</span>;
    case "failed":
      return <span className="kit-badge kit-badge--bad">AI: ошибка анализа</span>;
    case "pending":
      return <span className="kit-badge">AI: анализируется</span>;
    default:
      return <span className="kit-badge">AI: нет анализа</span>;
  }
}

interface CrashInfo {
  status: "pending" | "done" | "failed" | "none";
  analysis?: CrashAiAnalysis;
}

export function EventsView() {
  const [logs, setLogs] = useState<ServerLogSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const [typeFilter, setTypeFilter] = useState<EventTypeFilter>("all");
  const [timeFilter, setTimeFilter] = useState<TimeFilter>("7d");
  const [playerFilter, setPlayerFilter] = useState("");

  // AI-статусы крашей: id записи → статус/вердикт. Грузятся после основного
  // списка, только для краш-записей.
  const [crashInfo, setCrashInfo] = useState<Record<number, CrashInfo>>({});
  const [analyzing, setAnalyzing] = useState<Record<number, boolean>>({});
  const [analyzeError, setAnalyzeError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(null);
    api
      .getServerLogs()
      .then((response) => {
        if (!alive) return;
        setLogs(response.logs);
      })
      .catch((cause: unknown) => {
        if (alive) setError(cause instanceof Error ? cause.message : "Не удалось загрузить журнал");
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, []);

  // Докачка деталей крашей: сводка не несёт aiStatus, берём его из полной
  // записи. Не валим список, если детали не получились — просто нет бейджа.
  useEffect(() => {
    if (!logs) return;
    let alive = true;
    const crashes = logs.filter((entry) => isCrash(entry.eventType));
    Promise.all(
      crashes.map(async (entry) => {
        try {
          const details = await api.getServerLog(entry.id);
          const status = details.aiStatus === "pending" || details.aiStatus === "done" || details.aiStatus === "failed" ? details.aiStatus : "none";
          return [entry.id, { status, analysis: details.aiAnalysis } as CrashInfo] as const;
        } catch {
          return [entry.id, { status: "none" } as CrashInfo] as const;
        }
      }),
    ).then((pairs) => {
      if (!alive) return;
      setCrashInfo(Object.fromEntries(pairs));
    });
    return () => {
      alive = false;
    };
  }, [logs]);

  const filtered = useMemo(() => {
    const list = logs ?? [];
    const since = timeFilter === "all" ? 0 : Date.now() - (timeFilter === "24h" ? DAY_MS : timeFilter === "7d" ? 7 * DAY_MS : 30 * DAY_MS);
    const player = playerFilter.trim().toLowerCase();
    return list.filter((entry) => {
      if (typeFilter !== "all" && entry.eventType !== typeFilter) return false;
      if (Date.parse(entry.recordedAt) < since) return false;
      if (player && !(entry.username ?? "").toLowerCase().includes(player)) return false;
      return true;
    });
  }, [logs, typeFilter, timeFilter, playerFilter]);

  const analyze = useCallback(
    async (id: number) => {
      setAnalyzing((state) => ({ ...state, [id]: true }));
      setAnalyzeError(null);
      try {
        const analysis = await api.analyzeServerLog(id);
        setCrashInfo((state) => ({
          ...state,
          [id]: { status: analysis.error ? "failed" : "done", analysis },
        }));
      } catch (cause: unknown) {
        const message = cause instanceof Error ? cause.message : "Не удалось выполнить анализ";
        setAnalyzeError(`Крах #${id}: ${message}`);
        setCrashInfo((state) => ({ ...state, [id]: { status: "failed", analysis: state[id]?.analysis } }));
      } finally {
        setAnalyzing((state) => ({ ...state, [id]: false }));
      }
    },
    [],
  );

  const rows: LogRow[] = filtered.map((entry) => {
    const meta = eventTypeMeta(entry.eventType);
    const info = isCrash(entry.eventType) ? crashInfo[entry.id] : undefined;
    const summary = (
      <>
        {entry.summary}
        {info && <span className="kit-logtable-badge"> <AiBadge status={info.status} /></span>}
      </>
    );
    return { id: entry.id, time: entry.recordedAt, type: meta.label, state: meta.state, player: entry.username, summary };
  });

  return (
    <div className="kit-events">
      <SectionCard
        title="События сервера"
        subtitle={
          logs
            ? `Записей за 30 дней: ${logs.length} · показано: ${filtered.length}`
            : undefined
        }
        loading={loading}
        error={error}
      >
        <div className="kit-events-filters">
          <Select<EventTypeFilter>
            value={typeFilter}
            onChange={setTypeFilter}
            options={EVENT_TYPE_OPTIONS}
            ariaLabel="Тип события"
            label="Тип события"
          />
          <label className="kit-input">
            <span className="kit-input-label">Игрок</span>
            <input
              type="text"
              value={playerFilter}
              placeholder="ник или часть ника"
              onChange={(event) => setPlayerFilter(event.target.value)}
            />
          </label>
          <div className="kit-input">
            <span className="kit-input-label">Период</span>
            <Segmented<TimeFilter> value={timeFilter} onChange={setTimeFilter} options={TIME_OPTIONS} ariaLabel="Период" />
          </div>
        </div>
        {analyzeError && <div className="kit-card-error">{analyzeError}</div>}
        <LogTable
          rows={rows}
          renderActions={(row) => {
            const entry = filtered.find((item) => item.id === row.id);
            if (!entry || !isCrash(entry.eventType)) return null;
            const info = crashInfo[entry.id];
            if (info?.status === "done") return <span className="kit-muted-note">вердикт получен</span>;
            if (info?.status === "pending") return <span className="kit-muted-note">анализ идёт</span>;
            return (
              <button
                type="button"
                className="kit-button"
                disabled={Boolean(analyzing[entry.id])}
                onClick={() => void analyze(entry.id)}
                title={info?.status === "failed" ? "Повторить AI-анализ краша" : "Разобрать краш через AI"}
              >
                {analyzing[entry.id] ? "Анализ…" : info?.status === "failed" ? "Повторить AI" : "Разобрать AI"}
              </button>
            );
          }}
        />
      </SectionCard>
    </div>
  );
}
