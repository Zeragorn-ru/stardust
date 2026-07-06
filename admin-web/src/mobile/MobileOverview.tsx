import { useEffect, useMemo, useState } from "react";
import { api, ApiError } from "../api";
import type { Account, BuildHeader, Settings } from "../types";
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
    }
    load();
    return () => {
      cancelled = true;
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
      <section className="m-hero-card">
        <span className="m-eyebrow">Infrastructure Overview</span>
        <h1>Панель сервера</h1>
        <p>Состояние сборки, игроков и интеграций без перехода в десктопную версию.</p>
      </section>

      <div className="m-metric-grid">
        <Metric label="Builds" value={loading ? "..." : String(builds.length)} hint={activeBuild?.name ?? "нет active"} tone="blue" />
        <Metric label="Players" value={loading ? "..." : String(accounts.length)} hint={`${stats.admins} admin · ${stats.banned} ban`} tone="green" />
        <Metric label="Telegram" value={settings?.telegramTokenSet ? "on" : "off"} hint={settings?.telegramBotUsername ? `@${settings.telegramBotUsername}` : "not set"} tone={settings?.telegramTokenSet ? "green" : "yellow"} />
        <Metric label="SFTP" value={settings?.sftpPasswordSet ? "ready" : "setup"} hint={settings?.sftpHost || "host empty"} tone={settings?.sftpPasswordSet ? "green" : "yellow"} />
      </div>

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
          <span className="m-row-main"><strong>Аккаунты</strong><small>{stats.linked}/{accounts.length} Telegram linked</small></span>
        </button>
        <button className="m-wide-action" type="button" onClick={() => onOpenTab("customization")}>
          <span className="m-row-icon"><IconBox size={16} /></span>
          <span className="m-row-main"><strong>Косметика</strong><small>Бейджи и градиенты ника</small></span>
        </button>
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
