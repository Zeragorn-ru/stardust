// Обзор: телеметрия сервера, события игроков, статус бэкапа.

import { useCallback } from "react";
import { api } from "../api";
import { useAsyncData } from "../ui/useAsyncData";
import {
  Chip,
  EmptyState,
  PageState,
  Panel,
  StaleBanner,
  StatTile,
} from "../ui/components";
import { formatDateTime } from "../format";

export function OverviewPage() {
  const fetcher = useCallback(
    () => Promise.all([api.getServerTelemetry(), api.getBackupStatus()]),
    [],
  );
  const { data, loading, error, reload } = useAsyncData(fetcher, { pollMs: 30000 });

  return (
    <PageState loading={loading} error={error} onRetry={reload}>
      {data && <Overview data={data} stale={error} />}
    </PageState>
  );
}

function Overview({
  data,
  stale,
}: {
  data: [Awaited<ReturnType<typeof api.getServerTelemetry>>, Awaited<ReturnType<typeof api.getBackupStatus>>];
  stale: string | null;
}) {
  const [telemetry, backup] = data;
  const latest = telemetry.samples[0];

  return (
    <div className="page-stack">
      {stale && <StaleBanner message={stale} />}

      <div className="stat-grid">
        <StatTile
          label="Онлайн сейчас"
          value={latest ? latest.onlineCount : "—"}
          detail={latest && latest.players.length > 0 ? latest.players.join(", ") : "Игроков нет"}
        />
        <StatTile
          label="Средний онлайн"
          value={Math.round(telemetry.averageOnline * 10) / 10}
          detail="За последние часы"
        />
        <StatTile
          label="TPS"
          value={latest ? latest.tps.toFixed(1) : "—"}
          tone={latest && latest.tps < 18 ? "warn" : "ok"}
          detail="Норма: 20"
        />
        <StatTile
          label="MSPT"
          value={latest ? latest.mspt.toFixed(1) : "—"}
          tone={latest && latest.mspt > 40 ? "warn" : "ok"}
          detail="Норма: < 50"
        />
      </div>

      <div className="page-columns">
        <Panel title="Последние события" description="Входы и выходы игроков">
          {telemetry.events.length === 0 ? (
            <EmptyState title="Событий пока нет" body="Как только игрок зайдёт, событие появится здесь." />
          ) : (
            <div className="event-list">
              {telemetry.events.slice(0, 12).map((event, i) => (
                <div key={i} className="event-row">
                  <Chip tone={event.event === "join" ? "ok" : "neutral"}>
                    {event.event === "join" ? "вошёл" : "вышел"}
                  </Chip>
                  <span className="ellipsis">{event.username}</span>
                  <span className="spacer faint mono ellipsis" title={event.recordedAt}>
                    {formatDateTime(event.recordedAt)}
                  </span>
                </div>
              ))}
            </div>
          )}
        </Panel>

        <Panel title="Обслуживание" description="Фоновые задачи платформы">
          <div className="service-list">
            <ServiceRow
              label="Бэкап"
              state={backup.state ?? backup.status ?? "idle"}
              detail={
                backup.lastRunAt
                  ? `Последний запуск: ${formatDateTime(backup.lastRunAt)}`
                  : "Ещё не запускался"
              }
            />
            <ServiceRow label="Активная сборка" state="idle" detail="Управляется в разделе «Сборки»" />
          </div>
        </Panel>
      </div>
    </div>
  );
}

function ServiceRow({ label, state, detail }: { label: string; state: string; detail: string }) {
  const tone = state === "success" ? "ok" : state === "error" ? "err" : state === "running" ? "info" : "neutral";
  const text = state === "success" ? "успех" : state === "error" ? "ошибка" : state === "running" ? "выполняется" : "ожидание";
  return (
    <div className="service-row">
      <div className="grow">
        <div>{label}</div>
        <div className="faint" style={{ fontSize: "var(--fs-xs)" }}>{detail}</div>
      </div>
      <Chip tone={tone}>{text}</Chip>
    </div>
  );
}

export default OverviewPage;
