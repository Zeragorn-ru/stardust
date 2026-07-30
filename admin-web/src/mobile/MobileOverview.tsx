import { useEffect, useMemo, useState } from "react";
import { api, ApiError } from "../api";
import type { Account, BuildHeader, ServerTelemetry, Settings } from "../types";
import { useToast } from "../ui/feedback";
import { IconBox, IconChevronRight, IconSync, IconUsers } from "../ui/icons";

type MobileTab = "overview" | "builds" | "accounts" | "customization" | "settings";

type MobileOverviewProps = {
  onOpenTab: (tab: MobileTab) => void;
  onOpenBuild: (buildId: number) => void;
};

export function MobileOverview({ onOpenTab, onOpenBuild }: MobileOverviewProps) {
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
        /* telemetry optional */
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
  const stats = useMemo(() => ({
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
    <div className="m-screen m-overview">
      <section className="m-hero-card m-hero-card--overview">
        <span className="m-eyebrow">Infrastructure Overview</span>
        <h1>Панель сервера</h1>
        <p>Состояние сборки, игроков и интеграций без перехода в десктопную версию.</p>
        <div className="m-hero-pills">
          <span>{activeBuild ? `Активна ${activeBuild.name}` : "Нет активной сборки"}</span>
          <span>{settings?.telegramTokenSet ? "Telegram подключен" : "Telegram требует настройки"}</span>
        </div>
      </section>

      <div className="m-metric-grid">
        <Metric label="Сборки" value={loading ? "..." : String(builds.length)} hint={activeBuild?.name ?? "активная не выбрана"} tone="blue" />
        <Metric label="Игроки" value={loading ? "..." : String(accounts.length)} hint={`${stats.admins} админ · ${stats.banned} бан`} tone="green" />
        <Metric label="Telegram" value={settings?.telegramTokenSet ? "online" : "offline"} hint={settings?.telegramBotUsername ? `@${settings.telegramBotUsername}` : "не задан"} tone={settings?.telegramTokenSet ? "green" : "yellow"} />
        <Metric label="SFTP" value={settings?.sftpPasswordSet ? "ready" : "setup"} hint={settings?.sftpHost || "хост не задан"} tone={settings?.sftpPasswordSet ? "green" : "yellow"} />
      </div>

      {telemetry && telemetry.samples.length > 0 && (() => {
        const latest = telemetry.samples[telemetry.samples.length - 1];
        const samples = telemetry.samples;
        const maxOnline = Math.max(1, ...samples.map((s) => s.onlineCount));
        const avg = (field: "tps" | "mspt", count: number) => {
          const slice = samples.slice(-count);
          return slice.length > 0 ? slice.reduce((s, v) => s + v[field], 0) / slice.length : 0;
        };
        const tps5 = avg("tps", 20);
        const tps10 = avg("tps", 40);
        const mspt5 = avg("mspt", 20);
        const mspt10 = avg("mspt", 40);
        const w = 600, h = 120;
        const pathPoints = samples.map((s, i) => {
          const x = samples.length < 2 ? w / 2 : (i / (samples.length - 1)) * w;
          const y = h - 10 - (s.onlineCount / maxOnline) * (h - 20);
          return `${x},${y}`;
        }).join(" ");
        return (
          <section className="m-section-card">
            <div className="m-section-head">
              <div>
                <span className="m-eyebrow">Live telemetry</span>
                <h2>Телеметрия</h2>
              </div>
            </div>
            <div className="m-metric-grid">
              <Metric label="TPS" value={latest.tps.toFixed(1)} hint={`5м: ${tps5.toFixed(1)} · 10м: ${tps10.toFixed(1)}`} tone={latest.tps >= 18 ? "green" : "yellow"} />
              <Metric label="Нагрузка" value={latest.mspt.toFixed(1)} hint={`5м: ${mspt5.toFixed(1)} · 10м: ${mspt10.toFixed(1)}`} tone={latest.mspt <= 40 ? "green" : "yellow"} />
              <Metric label="Онлайн" value={String(latest.onlineCount)} hint="игроков" tone="blue" />
            </div>
            <div style={{ overflowX: "auto", border: "1px solid var(--border)", borderRadius: "var(--radius)", background: "linear-gradient(180deg, rgba(76,139,245,.07), transparent)", padding: "10px 8px 6px", marginTop: 10 }}>
              <svg viewBox={`0 0 ${w} ${h}`} style={{ display: "block", width: "100%", height: 120 }}>
                <defs>
                  <linearGradient id="m-online-fill" x1="0" x2="0" y1="0" y2="1">
                    <stop offset="0" stopColor="var(--accent)" stopOpacity=".34" />
                    <stop offset="1" stopColor="var(--accent)" stopOpacity="0" />
                  </linearGradient>
                </defs>
                <polyline points={`0,${h} ${pathPoints} ${w},${h}`} fill="url(#m-online-fill)" stroke="none" />
                <polyline points={pathPoints} fill="none" stroke="var(--accent)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
                <text x={w - 4} y={h - 8 - (latest.onlineCount / maxOnline) * (h - 20)} textAnchor="end" fill="var(--accent)" fontSize="14" fontWeight="600">{latest.onlineCount}</text>
              </svg>
              <div style={{ display: "flex", justifyContent: "space-between", color: "var(--faint)", fontSize: 10 }}><span>24ч</span><span>сейчас</span></div>
            </div>
            {telemetry.events.length > 0 && (
              <div style={{ marginTop: 10, fontSize: 12, color: "var(--muted)" }}>
                {telemetry.events.slice(-4).reverse().map((ev, i) => (
                  <div key={`${ev.recordedAt}-${i}`} style={{ display: "flex", gap: 6, alignItems: "center", padding: "4px 0" }}>
                    <span style={{ width: 6, height: 6, borderRadius: "50%", background: ev.event === "join" ? "var(--ok)" : "var(--danger)", flexShrink: 0 }} />
                    <strong style={{ color: "var(--text)" }}>{ev.username}</strong>
                    <span>{ev.event === "join" ? "вошёл" : "вышел"}</span>
                    <time style={{ marginLeft: "auto" }}>{new Date(ev.recordedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time>
                  </div>
                ))}
              </div>
            )}
          </section>
        );
      })()}

      <section className="m-section-card">
        <div className="m-section-head">
          <div>
            <span className="m-eyebrow">Deployment</span>
            <h2>Активная сборка</h2>
          </div>
          <button className="m-text-link" type="button" onClick={() => onOpenTab("builds")}>Все</button>
        </div>
        {activeBuild ? (
          <button className="m-service-row" type="button" onClick={() => onOpenBuild(activeBuild.id)}>
            <span className="m-row-icon"><IconBox size={16} /></span>
            <span className="m-row-main"><strong>{activeBuild.name}</strong><small>v{activeBuild.version} · {activeBuild.loaderKind} · MC {activeBuild.mcVersion}</small></span>
            <IconChevronRight size={18} />
          </button>
        ) : (
          <p className="muted">Активная сборка не выбрана.</p>
        )}
      </section>

      <section className="m-section-card">
        <div className="m-section-head">
          <div>
            <span className="m-eyebrow">Operations</span>
            <h2>Быстрые действия</h2>
          </div>
        </div>
        <button className="m-wide-action" onClick={syncStats} disabled={syncing}>
          <span className="m-row-icon"><IconSync size={16} className={syncing ? "spin" : ""} /></span>
          <span className="m-row-main"><strong>{syncing ? "Синхронизация..." : "Синхронизировать статистику"}</strong><small>Обновить playtime из SFTP stats</small></span>
        </button>
        <button className="m-wide-action" type="button" onClick={() => onOpenTab("accounts")}>
          <span className="m-row-icon"><IconUsers size={16} /></span>
          <span className="m-row-main"><strong>Аккаунты</strong><small>{stats.linked}/{accounts.length} связаны с Telegram</small></span>
        </button>
        <button className="m-wide-action" type="button" onClick={() => onOpenTab("customization")}>
          <span className="m-row-icon"><IconBox size={16} /></span>
          <span className="m-row-main"><strong>Косметика</strong><small>Бейджи и градиенты ника</small></span>
        </button>
      </section>

      <section className="m-section-card">
        <div className="m-section-head">
          <div>
            <span className="m-eyebrow">iPhone / iPad web-app</span>
            <h2>Частые сценарии</h2>
          </div>
        </div>
        <div className="m-journey-grid">
          <button className="m-journey-card" type="button" onClick={() => onOpenTab("builds")}>
            <strong>Сборки</strong>
            <small>Открыть релизы, файлы и активную версию</small>
          </button>
          <button className="m-journey-card" type="button" onClick={() => onOpenTab("settings")}>
            <strong>Интеграции</strong>
            <small>Проверить Telegram, SFTP и backend-настройки</small>
          </button>
        </div>
      </section>
    </div>
  );
}

function Metric({ label, value, hint, tone }: { label: string; value: string; hint: string; tone: "blue" | "green" | "yellow" }) {
  return (
    <div className={`m-metric m-metric--${tone}`}>
      <span>{label}</span>
      <strong>{value}</strong>
      <small>{hint}</small>
    </div>
  );
}
