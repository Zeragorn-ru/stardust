import { useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { api, ApiError } from "../api";
import type { Account, BuildHeader, Settings } from "../types";
import { IconBox, IconPlus, IconSettings, IconSync, IconUsers } from "../ui/icons";
import { useToast } from "../ui/feedback";
import { Button, Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "../ui/shadcn";

export function OverviewView() {
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
      <section className="hero-panel">
        <div className="hero-copy">
          <span className="eyebrow">Stardust operations</span>
          <h1>Infrastructure Overview</h1>
          <p>
            Живое состояние внутренней платформы: активная сборка, доступ игроков, Telegram, SFTP и быстрые операции без лишней навигации.
          </p>
        </div>
        <div className="hero-actions">
          <Link className="button primary" to="/builds/new">
            <IconPlus size={15} /> Новая сборка
          </Link>
          <Button variant="secondary" onClick={syncStats} disabled={syncing}>
            <IconSync size={15} className={syncing ? "spin" : ""} />
            {syncing ? "Синхронизация" : "Синхр. статистики"}
          </Button>
        </div>
      </section>

      <section className="ops-grid">
        <MetricCard label="Сборок" value={loading ? "..." : builds.length} hint={activeBuild ? `Активна: ${activeBuild.name}` : "Активная сборка не выбрана"} tone="blue" />
        <MetricCard label="Аккаунтов" value={loading ? "..." : accounts.length} hint={`${totals.admins} админ(ов), ${totals.banned} в бане`} tone="green" />
        <MetricCard label="Telegram" value={settings?.telegramTokenSet ? "online" : "off"} hint={settings?.telegramBotUsername ? `@${settings.telegramBotUsername}` : "Токен не задан"} tone={settings?.telegramTokenSet ? "green" : "yellow"} />
        <MetricCard label="SFTP" value={settings?.sftpPasswordSet ? "ready" : "setup"} hint={settings?.sftpHost || "Подключение не настроено"} tone={settings?.sftpPasswordSet ? "green" : "yellow"} />
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
