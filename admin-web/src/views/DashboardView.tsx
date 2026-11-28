// DashboardView — дашборд admin-v2 (этап 1): четыре секции на реальных
// данных api.ts. Данные грузятся параллельно; ошибка отдельной секции
// показывается внутри её карточки и не валит остальные.

import { useEffect, useState } from "react";
import { api } from "../api";
import type {
  Account,
  BackupStatus,
  BuildHeader,
  LauncherChannel,
  LauncherRelease,
  ServerLogsResponse,
  ServerTelemetry,
  Settings,
} from "../types";
import { Chart, LogTable, Metric, SectionCard } from "../ui/kit";
import type { ChartPoint, LogRow, MetricState } from "../ui/kit";
import { formatDateTime, formatSize } from "../format";

// Пороги MSPT: 50 тиков/с = 20 мс на тик; 40 мс — уже просадка, 50 — шторм.
const MSPT_OK = 40;
const MSPT_WARN = 50;

const WINDOW_HOURS = 24;
const HOUR_MS = 3_600_000;

/** Ленивый одноразовый запрос секции: данные, ошибка, загрузка. */
function useSection<T>(load: () => Promise<T>): { data: T | null; error: string | null; loading: boolean } {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(null);
    load()
      .then((value) => {
        if (alive) setData(value);
      })
      .catch((cause: unknown) => {
        if (alive) setError(cause instanceof Error ? cause.message : "Не удалось загрузить данные");
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
    // Запрос один на монтирование секции; load стабилен на практике.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { data, error, loading };
}

/** Человекочитаемое имя типа события журнала. */
function eventTypeLabel(eventType: string): { label: string; state: LogRow["state"] } {
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

function msptState(mspt: number): MetricState {
  if (mspt <= MSPT_OK) return "ok";
  if (mspt <= MSPT_WARN) return "warn";
  return "bad";
}

/**
 * Точки графика онлайна с честными разрывами: телеметрия — выборка с
 * постоянным шагом, и если между сэмплами пауза заметно длиннее шага
 * (сервер лежал), вставляем null — линия рвётся, а не дорисовывает ноль.
 */
function onlineChartPoints(samples: ServerTelemetry["samples"]): ChartPoint[] {
  const cutoff = Date.now() - WINDOW_HOURS * HOUR_MS;
  const sorted = samples
    .map((sample) => ({ t: Date.parse(sample.recordedAt), v: sample.onlineCount }))
    .filter((point) => !Number.isNaN(point.t) && point.t >= cutoff)
    .sort((a, b) => a.t - b.t);

  const points: ChartPoint[] = [];
  let step = 0;
  for (let i = 0; i < sorted.length; i += 1) {
    const point = sorted[i];
    if (i > 0) {
      const gap = point.t - sorted[i - 1].t;
      // Шаг оцениваем по медиане соседних интервалов (просто: бегущий минимум).
      if (step === 0 || gap < step) step = gap;
      if (step > 0 && gap > step * 3) {
        points.push({ t: sorted[i - 1].t + gap / 2, v: null });
      }
    }
    points.push(point);
  }
  return points;
}

function StatusLine({ label, ok, value }: { label: string; ok: boolean; value?: string }) {
  return (
    <div className={`kit-status ${ok ? "kit-status--ok" : "kit-status--bad"}`}>
      <span className="kit-status-dot" aria-hidden="true" />
      <span>{label}</span>
      {value && <span className="kit-status-value">{value}</span>}
    </div>
  );
}

export function DashboardView() {
  return (
    <div className="kit-dashboard">
      <ServerSection />
      <div className="kit-two-col">
        <PlayersSection />
        <BuildsSection />
      </div>
      <InfraSection />
    </div>
  );
}

function ServerSection() {
  const telemetry = useSection<ServerTelemetry>(() => api.getServerTelemetry());

  const samples = telemetry.data?.samples ?? [];
  const latest = samples.length > 0 ? samples[samples.length - 1] : null;
  const points = telemetry.data ? onlineChartPoints(telemetry.data.samples) : [];

  return (
    <SectionCard
      title="Сервер"
      subtitle={
        latest
          ? `Последний сэмпл: ${formatDateTime(latest.recordedAt)} · средний онлайн за сутки: ${
              telemetry.data?.averageOnline?.toFixed(1) ?? "—"
            }`
          : undefined
      }
      loading={telemetry.loading}
      error={telemetry.error}
    >
      <div className="kit-metric-row">
        <Metric value={latest?.onlineCount ?? "—"} label="Онлайн" hero />
        <Metric value={latest ? latest.tps.toFixed(1) : "—"} label="TPS" state={latest && latest.tps >= 19 ? "ok" : "warn"} />
        <Metric
          value={latest ? latest.mspt.toFixed(1) : "—"}
          label="MSPT"
          hint={`≤ ${MSPT_OK} ок · ≤ ${MSPT_WARN} warn`}
          state={latest ? msptState(latest.mspt) : "neutral"}
        />
      </div>
      <Chart points={points} hours={WINDOW_HOURS} unit=" чел." ariaLabel="Онлайн на сервере за последние 24 часа" />
    </SectionCard>
  );
}

function PlayersSection() {
  const logs = useSection<ServerLogsResponse>(() => api.getServerLogs());
  const accounts = useSection<Account[]>(() => api.listAccounts());
  const telemetry = useSection<ServerTelemetry>(() => api.getServerTelemetry());

  const rows: LogRow[] = (logs.data?.logs ?? []).slice(0, 10).map((entry) => {
    const meta = eventTypeLabel(entry.eventType);
    return { time: entry.recordedAt, type: meta.label, state: meta.state, player: entry.username, summary: entry.summary };
  });

  const list = accounts.data ?? [];
  const dayAgo = Date.now() - HOUR_MS;
  const seenToday = new Set(
    (telemetry.data?.events ?? [])
      .filter((event) => Date.parse(event.recordedAt) >= dayAgo)
      .map((event) => event.username),
  ).size;

  return (
    <SectionCard title="Игроки и события" subtitle="Последние события сервера и сводка аккаунтов" loading={logs.loading} error={logs.error}>
      <div className="kit-accounts-line">
        <Metric value={accounts.error ? "—" : list.length} label="Аккаунтов" state="neutral" />
        <Metric value={accounts.error ? "—" : list.filter((account) => account.telegramLinked).length} label="С Telegram" />
        <Metric value={accounts.error ? "—" : list.filter((account) => account.banned).length} label="Забанено" state="neutral" />
        <Metric value={telemetry.error ? "—" : seenToday} label="Игроков за 24 ч" state="ok" />
      </div>
      {accounts.error && <div className="kit-card-error">Аккаунты: {accounts.error}</div>}
      {telemetry.error && <div className="kit-card-error">Телеметрия: {telemetry.error}</div>}
      <LogTable rows={rows} />
    </SectionCard>
  );
}

function BuildsSection() {
  const builds = useSection<BuildHeader[]>(() => api.listBuilds());
  const channels = useSection<LauncherChannel[]>(() => api.getLauncherChannels());
  const releases = useSection<LauncherRelease[]>(() => api.getReleases());

  const list = builds.data ?? [];
  const latestRelease = releases.data?.[0] ?? null;

  return (
    <SectionCard
      title="Сборки и релизы"
      subtitle={latestRelease ? `Последний релиз: ${latestRelease.tag}${latestRelease.prerelease ? " (pre-release)" : ""}` : undefined}
      loading={builds.loading}
      error={builds.error}
    >
      <div className="kit-build-list">
        {list.map((build) => (
          <div key={build.id} className={`kit-build-row${build.isActive ? " kit-build-row--active" : ""}`}>
            <span className="kit-build-name">
              {build.name}
              {build.isActive ? " · активная" : ""}
            </span>
            <span className="kit-build-meta">
              {build.mcVersion} · {build.loaderKind} {build.loaderVersion}
            </span>
          </div>
        ))}
        {!builds.loading && !builds.error && list.length === 0 && <div className="kit-card-empty">Сборок нет</div>}
      </div>
      <div className="kit-channels">
        {(channels.data ?? []).map((channel) => (
          <div key={channel.channel} className="kit-channel">
            <span className="kit-channel-name">Канал {channel.channel}</span>
            <span className="kit-channel-tag">{channel.tag ?? "не настроен"}</span>
          </div>
        ))}
        {!channels.loading && !channels.error && (channels.data ?? []).length === 0 && (
          <div className="kit-card-empty">Каналы апдейтера не настроены</div>
        )}
      </div>
      {channels.error && <div className="kit-card-error">Каналы: {channels.error}</div>}
      {releases.error && <div className="kit-card-error">Релизы: {releases.error}</div>}
    </SectionCard>
  );
}

function InfraSection() {
  const backup = useSection<BackupStatus>(() => api.getBackupStatus());
  const settings = useSection<Settings>(() => api.getSettings());

  const state = backup.data?.state ?? backup.data?.status ?? null;
  const finishedAt = backup.data?.finishedAt ?? backup.data?.lastRunAt ?? null;
  const size = backup.data?.lastSizeBytes;

  return (
    <SectionCard title="Инфраструктура" subtitle="Бэкапы, SFTP и сервисы платформы" loading={backup.loading && settings.loading} error={backup.error}>
      <div className="kit-infra-list">
        <div className="kit-infra-row">
          <span>Последний бэкап</span>
          <span className="kit-infra-value">
            {finishedAt ? formatDateTime(finishedAt) : "—"}
            {size != null ? ` · ${formatSize(size)}` : ""}
          </span>
        </div>
        <div className="kit-infra-row">
          <span>Статус бэкапа</span>
          <StatusLine
            label={state ?? "неизвестно"}
            ok={state === "success" || state === "idle"}
          />
        </div>
        {settings.error ? (
          <div className="kit-card-error">Настройки: {settings.error}</div>
        ) : settings.data ? (
          <>
            <div className="kit-infra-row">
              <span>SFTP</span>
              <StatusLine
                label={settings.data.sftpHost ? "настроен" : "не настроен"}
                ok={Boolean(settings.data.sftpHost)}
                value={settings.data.sftpHost}
              />
            </div>
            <div className="kit-infra-row">
              <span>Telegram-бот</span>
              <StatusLine label={settings.data.telegramTokenSet ? "токен задан" : "токен не задан"} ok={settings.data.telegramTokenSet} />
            </div>
            <div className="kit-infra-row">
              <span>Crash-AI</span>
              <StatusLine
                label={settings.data.crashAiEnabled ? "включён" : "выключен"}
                ok={Boolean(settings.data.crashAiEnabled)}
                value={settings.data.crashAiModel}
              />
            </div>
            <div className="kit-infra-row">
              <span>Очистка чужих модов</span>
              <StatusLine label={settings.data.purgeExternal ? "включена" : "выключена"} ok={Boolean(settings.data.purgeExternal)} />
            </div>
          </>
        ) : null}
      </div>
    </SectionCard>
  );
}
