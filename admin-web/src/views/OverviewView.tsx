import { useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { api, ApiError } from "../api";
import type { Account, BuildHeader, ServerTelemetry, Settings } from "../types";
import { formatTelemetryTime } from "../format";
import { IconBox, IconSettings, IconSync, IconUsers } from "../ui/icons";
import { useToast } from "../ui/feedback";
import { Button, Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "../ui/shadcn";

export function OverviewView() {
  const toast = useToast();
  const [builds, setBuilds] = useState<BuildHeader[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [telemetry, setTelemetry] = useState<ServerTelemetry | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const [nextBuilds, nextAccounts, nextSettings] = await Promise.all([
          api.listBuilds(),
          api.listAccounts(),
          api.getSettings(),
        ]);
        if (cancelled) return;
        setBuilds(nextBuilds);
        setAccounts(nextAccounts);
        setSettings(nextSettings);
      } catch (err) {
        toast.error(err instanceof ApiError ? err.message : "Не удалось загрузить обзор");
      } finally {
        if (!cancelled) setLoading(false);
      }
      try {
        const nextTelemetry = await api.getServerTelemetry();
        if (!cancelled) setTelemetry(nextTelemetry);
      } catch {
        /* telemetry optional — mod may not be connected yet */
      }
    }
    load();
    const timer = window.setInterval(load, 30_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [toast]);

  const activeBuild = builds.find((b) => b.isActive) ?? null;
  const totals = useMemo(() => ({
    admins: accounts.filter((a) => a.isAdmin).length,
    banned: accounts.filter((a) => a.banned).length,
    linked: accounts.filter((a) => a.telegramLinked).length,
  }), [accounts]);

  async function syncStats() {
    setSyncing(true);
    try {
      const res = await api.syncStats();
      toast.success(`Статистика обновлена: ${res.updated} игроков`);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Ошибка синхронизации");
    } finally {
      setSyncing(false);
    }
  }

  return (
    <div className="view overview-view">
      <section className="hero-panel hero-panel--overview">
        <div className="hero-copy">
          <span className="eyebrow">Stardust operations</span>
          <h1>Infrastructure overview</h1>
          <p>
            Живое состояние платформы: активная сборка, доступ игроков, Telegram, SFTP и быстрые операции без лишней навигации.
          </p>
          <div className="overview-hero-pills">
            <span>{activeBuild ? `Активна сборка ${activeBuild.name}` : "Активная сборка не выбрана"}</span>
            <span>{settings?.telegramTokenSet ? "Telegram подключен" : "Telegram требует настройки"}</span>
            <span>{settings?.sftpPasswordSet ? "SFTP готов" : "SFTP требует настройки"}</span>
          </div>
        </div>
        <div className="hero-actions hero-actions--overview">
          <Button variant="secondary" onClick={syncStats} disabled={syncing}>
            <IconSync size={15} className={syncing ? "spin" : ""} />
            {syncing ? "Синхронизация" : "Синхронизировать статистику"}
          </Button>
        </div>
      </section>

      <section className="ops-grid">
        <MetricCard label="Сборки" value={loading ? "..." : builds.length} hint={activeBuild ? `Активна: ${activeBuild.name}` : "Активная сборка не выбрана"} tone="blue" />
        <MetricCard label="Аккаунты" value={loading ? "..." : accounts.length} hint={`${totals.admins} админ(ов), ${totals.banned} в бане`} tone="green" />
        <MetricCard label="Telegram" value={settings?.telegramTokenSet ? "online" : "offline"} hint={settings?.telegramBotUsername ? `@${settings.telegramBotUsername}` : "Токен не задан"} tone={settings?.telegramTokenSet ? "green" : "yellow"} />
        <MetricCard label="SFTP" value={settings?.sftpPasswordSet ? "ready" : "setup"} hint={settings?.sftpHost || "Подключение не настроено"} tone={settings?.sftpPasswordSet ? "green" : "yellow"} />
      </section>

      <TelemetryPanel telemetry={telemetry} />

      <section className="overview-action-grid">
        <Link className="overview-action-card" to={activeBuild ? `/builds/${activeBuild.id}` : "/builds"}>
          <span className="row-icon"><IconBox size={16} /></span>
          <div>
            <strong>{activeBuild ? "Открыть активную сборку" : "Перейти к сборкам"}</strong>
            <small>{activeBuild ? `${activeBuild.loaderKind} · MC ${activeBuild.mcVersion}` : "Проверить релизы, файлы и версии"}</small>
          </div>
        </Link>
        <Link className="overview-action-card" to="/accounts">
          <span className="row-icon"><IconUsers size={16} /></span>
          <div>
            <strong>Проверить игроков</strong>
            <small>{totals.linked}/{accounts.length} аккаунтов связаны с Telegram</small>
          </div>
        </Link>
        <Link className="overview-action-card" to="/settings">
          <span className="row-icon"><IconSettings size={16} /></span>
          <div>
            <strong>Открыть инфраструктуру</strong>
            <small>Telegram, SFTP и authlib-injector в одном разделе</small>
          </div>
        </Link>
      </section>

      <section className="overview-columns">
        <Card className="panel-flat">
          <CardHeader>
            <div>
              <span className="eyebrow">Deployment pipeline</span>
              <CardTitle>Сборки</CardTitle>
              <CardDescription>Последние сборки и активный релиз.</CardDescription>
            </div>
            <CardAction><Link className="link-action" to="/builds">Открыть</Link></CardAction>
          </CardHeader>
          <CardContent className="compact-list">
            {builds.slice(0, 5).map((build) => (
              <Link key={build.id} className="compact-row" to={`/builds/${build.id}`}>
                <span className="row-icon"><IconBox size={15} /></span>
                <span className="compact-row-main">
                  <strong>{build.name}</strong>
                  <small>{build.loaderKind} · MC {build.mcVersion} · v{build.version}</small>
                </span>
                {build.isActive && <span className="badge active">active</span>}
              </Link>
            ))}
            {!loading && builds.length === 0 && <p className="muted">Сборок пока нет.</p>}
          </CardContent>
        </Card>

        <Card className="panel-flat">
          <CardHeader>
            <div>
              <span className="eyebrow">Service status</span>
              <CardTitle>Сервисы</CardTitle>
              <CardDescription>Auth, Telegram и серверная статистика.</CardDescription>
            </div>
            <CardAction><Link className="link-action" to="/accounts">Открыть</Link></CardAction>
          </CardHeader>
          <CardContent className="compact-list">
            <InfoLine icon={<IconUsers size={15} />} label="Auth / аккаунты" value={`${accounts.length} игроков`} />
            <InfoLine icon={<IconUsers size={15} />} label="Telegram linked" value={`${totals.linked}/${accounts.length}`} />
            <InfoLine icon={<IconUsers size={15} />} label="Администраторы" value={String(totals.admins)} />
            <InfoLine icon={<IconUsers size={15} />} label="Баны" value={String(totals.banned)} />
            <Link className="compact-row compact-row--cta" to="/settings">
              <span className="row-icon"><IconSettings size={15} /></span>
              <span className="compact-row-main">
                <strong>Инфраструктура</strong>
                <small>Telegram, SFTP, authlib-injector</small>
              </span>
            </Link>
          </CardContent>
        </Card>
      </section>
    </div>
  );
}

function TelemetryPanel({ telemetry }: { telemetry: ServerTelemetry | null }) {
  const samples = telemetry?.samples ?? [];
  const [selected, setSelected] = useState<number | null>(null);
  const latest = samples[samples.length - 1];
  const maxOnline = Math.max(1, ...samples.map((sample) => sample.onlineCount));
  const chartTop = 56;

  // Each sample = ~15s. 5min = 20 samples, 10min = 40 samples.
  const avg = (field: "tps" | "mspt", count: number) => {
    const slice = samples.slice(-count);
    return slice.length > 0 ? slice.reduce((s, v) => s + v[field], 0) / slice.length : 0;
  };
  const tps5 = avg("tps", 20);
  const tps10 = avg("tps", 40);
  const mspt5 = avg("mspt", 20);
  const mspt10 = avg("mspt", 40);

  const width = 900;
  const height = 220;
  const points = samples.map((sample, index) => {
    const x = samples.length < 2 ? width / 2 : (index / (samples.length - 1)) * width;
    const y = height - 20 - (sample.onlineCount / maxOnline) * (height - chartTop - 20);
    return `${x},${y}`;
  }).join(" ");

  return (
    <>
      <div className="telemetry-cards-row">
        <Card className="panel-flat telemetry-panel">
          <CardHeader><small className="telemetry-card-label">TPS</small></CardHeader>
          <CardContent>
            <div className="telemetry-metrics-row">
              <span style={{ color: latest ? (latest.tps >= 19 ? "#22c55e" : latest.tps >= 10 ? "#f97316" : "#ef4444") : undefined }}>{latest ? latest.tps.toFixed(1) : "—"}</span>
              <span style={{ color: tps5 >= 19 ? "#22c55e" : tps5 >= 10 ? "#f97316" : "#ef4444" }}>{tps5.toFixed(1)}</span>
              <span style={{ color: tps10 >= 19 ? "#22c55e" : tps10 >= 10 ? "#f97316" : "#ef4444" }}>{tps10.toFixed(1)}</span>
            </div>
            <div className="telemetry-metrics-labels">
              <span>now</span><span>5min</span><span>10min</span>
            </div>
          </CardContent>
        </Card>
        <Card className="panel-flat telemetry-panel">
          <CardHeader><small className="telemetry-card-label">MSPT</small></CardHeader>
          <CardContent>
            <div className="telemetry-metrics-row">
              <span style={{ color: "#38bdf8" }}>{latest ? latest.mspt.toFixed(1) : "—"}</span>
              <span style={{ color: "#38bdf8" }}>{mspt5.toFixed(1)}</span>
              <span style={{ color: "#38bdf8" }}>{mspt10.toFixed(1)}</span>
            </div>
            <div className="telemetry-metrics-labels">
              <span>now</span><span>5min</span><span>10min</span>
            </div>
          </CardContent>
        </Card>
      </div>
      <Card className="panel-flat telemetry-panel">
        <CardHeader>
          <div>
            <span className="eyebrow">Live server telemetry</span>
            <CardTitle>Онлайн за 24 часа</CardTitle>
            <CardDescription>Нажмите на график, чтобы увидеть игроков в этот момент.</CardDescription>
          </div>
        </CardHeader>
        <CardContent>
          {samples.length === 0 ? <p className="muted">Мод ещё не прислал телеметрию.</p> : (
            <div className="telemetry-chart-wrap">
              <svg className="telemetry-chart" viewBox={`0 0 ${width} ${height}`} role="img" aria-label="График онлайна" onClick={(e) => {
                const rect = e.currentTarget.getBoundingClientRect();
                const relX = (e.clientX - rect.left) / rect.width;
                const idx = Math.round(relX * (samples.length - 1));
                setSelected(idx >= 0 && idx < samples.length ? idx : null);
              }}>
                <defs>
                  <linearGradient id="online-fill" x1="0" x2="0" y1="0" y2="1">
                    <stop offset="0" stopColor="var(--accent)" stopOpacity=".34" />
                    <stop offset="1" stopColor="var(--accent)" stopOpacity="0" />
                  </linearGradient>
                </defs>
                <polyline points={`0,${height} ${points} ${width},${height}`} fill="url(#online-fill)" stroke="none" />
                <polyline points={points} fill="none" stroke="var(--accent)" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
                {latest && (
                  <text x={width - 8} y={34} textAnchor="end" fill="#22c55e" fontSize="26" fontWeight="800">{latest.onlineCount}</text>
                )}
              </svg>
              <div className="telemetry-axis"><span>24ч назад</span><span>сейчас</span></div>
            </div>
          )}
          {selected !== null && samples[selected] && (
            <div className="telemetry-selected">
              <strong>{formatTelemetryTime(samples[selected].recordedAt)} · {samples[selected].onlineCount} игроков</strong>
              <span>{samples[selected].players.join(", ") || "В этот момент игроков не было"}</span>
            </div>
          )}
          <div className="telemetry-events">
            {(telemetry?.events ?? []).slice(-8).reverse().map((event, index) => (
              <div className="telemetry-event" key={`${event.recordedAt}-${event.username}-${index}`}>
                <span className={`telemetry-event-dot telemetry-event-dot--${event.event}`} />
                <strong>{event.username}</strong>
                <span>{event.event === "join" ? "вошёл" : "вышел"}</span>
                <time>{formatTelemetryTime(event.recordedAt)}</time>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
    </>
  );
}

function MetricCard({ label, value, hint, tone }: { label: string; value: string | number; hint: string; tone: "blue" | "green" | "yellow" }) {
  return (
    <div className={`metric-card metric-card--${tone}`}>
      <span>{label}</span>
      <strong>{value}</strong>
      <small>{hint}</small>
    </div>
  );
}

function InfoLine({ icon, label, value }: { icon: ReactNode; label: string; value: string }) {
  return (
    <div className="info-line">
      <span className="row-icon">{icon}</span>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}
