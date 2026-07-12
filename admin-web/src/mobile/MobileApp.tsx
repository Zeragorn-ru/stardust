// Мобильная оболочка админки (/m): один web-app экран с выдвижной левой
// навигацией. Вкладки переключаются локальным состоянием, без смены URL.

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { FeedbackProvider } from "../ui/feedback";
import { AuthProvider, useAuth } from "../app/useAuth";
import { MobileLogin } from "./MobileLogin";
import { MobileOverview } from "./MobileOverview";
import { MobileBuilds } from "./MobileBuilds";
import { MobileBuildDetail } from "./MobileBuildDetail";
import { MobileAccounts } from "./MobileAccounts";
import { MobileSettings } from "./MobileSettings";
import { MobileCustomization } from "./MobileCustomization";
import { IconBox, IconChart, IconClose, IconLogout, IconSettings, IconStar, IconUsers } from "../ui/icons";
import { switchViewHref } from "../app/viewMode";

export function MobileApp() {
  return (
    <FeedbackProvider>
      <AuthProvider>
        <Gate />
      </AuthProvider>
    </FeedbackProvider>
  );
}

function Gate() {
  const { authed, onLoggedIn } = useAuth();

  if (authed === null) {
    return (
      <div className="login-wrap muted">
        <span className="spinner" />
        Проверка сессии…
      </div>
    );
  }

  if (!authed) return <MobileLogin onLoggedIn={onLoggedIn} />;

  return <Shell />;
}

type MobileTab = "overview" | "builds" | "accounts" | "customization" | "settings";

const NAV: Array<{ tab: MobileTab; label: string; eyebrow: string; icon: ReactNode }> = [
  { tab: "overview", label: "Обзор", eyebrow: "Dashboard", icon: <IconChart size={19} /> },
  { tab: "builds", label: "Сборки", eyebrow: "Deployment", icon: <IconBox size={20} /> },
  { tab: "accounts", label: "Аккаунты", eyebrow: "Operations", icon: <IconUsers size={20} /> },
  { tab: "customization", label: "Косметика", eyebrow: "Identity", icon: <IconStar size={19} /> },
  { tab: "settings", label: "Система", eyebrow: "Integrations", icon: <IconSettings size={20} /> },
];

function Shell() {
  const { username, logout } = useAuth();
  const [activeTab, setActiveTab] = useState<MobileTab>("overview");
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [selectedBuildId, setSelectedBuildId] = useState<number | null>(null);

  const activeItem = NAV.find((item) => item.tab === activeTab) ?? NAV[0];
  const quickTabs = useMemo(() => NAV.slice(0, 3), []);

  useEffect(() => {
    if (!drawerOpen) return;

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setDrawerOpen(false);
    }

    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.body.style.overflow = "";
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [drawerOpen]);

  function openTab(tab: MobileTab) {
    setActiveTab(tab);
    setSelectedBuildId(null);
    setDrawerOpen(false);
  }

  function openBuild(buildId: number) {
    setActiveTab("builds");
    setSelectedBuildId(buildId);
    setDrawerOpen(false);
  }

  return (
    <div className="m-app">
      <header className="m-shell-head">
        <button
          className="m-menu-button"
          type="button"
          aria-label="Открыть меню"
          aria-expanded={drawerOpen}
          aria-controls="mobile-drawer"
          onClick={() => setDrawerOpen(true)}
        >
          <span />
          <span />
          <span />
        </button>
        <div className="m-shell-title">
          <span>{activeItem.eyebrow}</span>
          <strong>{selectedBuildId ? "Детали сборки" : activeItem.label}</strong>
        </div>
        <div className="m-shell-actions">
          <a className="m-shell-link" href={switchViewHref("desktop")}>ПК</a>
        </div>
      </header>

      <div className="m-quick-nav" aria-label="Быстрые разделы">
        {quickTabs.map((item) => (
          <button
            key={item.tab}
            className={`m-quick-nav-item${activeTab === item.tab && selectedBuildId == null ? " active" : ""}`}
            type="button"
            onClick={() => openTab(item.tab)}
          >
            {item.icon}
            <span>{item.label}</span>
          </button>
        ))}
      </div>

      {drawerOpen && <button className="m-drawer-scrim" aria-label="Закрыть меню" onClick={() => setDrawerOpen(false)} />}
      <aside
        id="mobile-drawer"
        className={`m-drawer${drawerOpen ? " open" : ""}`}
        aria-hidden={!drawerOpen}
        aria-label="Навигация админки"
      >
        <div className="m-drawer-brand">
          <span className="m-brand-mark"><span /></span>
          <div>
            <strong>StarDust</strong>
            <small>Control room</small>
          </div>
          <button className="icon-only m-drawer-close" type="button" aria-label="Закрыть меню" onClick={() => setDrawerOpen(false)}>
            <IconClose size={18} />
          </button>
        </div>
        <nav className="m-drawer-nav">
          {NAV.map((item) => (
            <button
              key={item.tab}
              className={`m-drawer-item${activeTab === item.tab ? " active" : ""}`}
              type="button"
              onClick={() => openTab(item.tab)}
            >
              {item.icon}
              <span>{item.label}</span>
            </button>
          ))}
        </nav>
        <div className="m-drawer-foot">
          {username && <span className="m-drawer-user">{username}</span>}
          <a className="m-drawer-item" href={switchViewHref("desktop")}>ПК-версия</a>
          <button className="m-drawer-item" type="button" onClick={logout}>
            <IconLogout size={18} />
            <span>Выйти</span>
          </button>
        </div>
      </aside>

      <main className="m-content">
        {activeTab === "overview" && <MobileOverview onOpenTab={openTab} onOpenBuild={openBuild} />}
        {activeTab === "builds" && selectedBuildId == null && <MobileBuilds onOpenBuild={openBuild} />}
        {activeTab === "builds" && selectedBuildId != null && (
          <MobileBuildDetail buildId={selectedBuildId} onBack={() => setSelectedBuildId(null)} onOpenBuild={openBuild} />
        )}
        {activeTab === "accounts" && <MobileAccounts />}
        {activeTab === "customization" && <MobileCustomization />}
        {activeTab === "settings" && <MobileSettings />}
      </main>
    </div>
  );
}
