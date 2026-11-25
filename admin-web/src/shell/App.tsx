// Оболочка: сайдбар + топбар + контент. Один адаптивный шелл: на узких
// экранах сайдбар превращается в drawer (меню закрывается по Escape и
// клику по подложке).

import { useEffect, useState } from "react";
import { NavLink, Navigate, Route, Routes, useLocation } from "react-router-dom";
import { lazy, Suspense } from "react";
import { AuthProvider, useAuth } from "../app/useAuth";
import { FeedbackProvider } from "../ui/feedback";
import { ContextMenuProvider, IconButton } from "../ui/components";
import { McText } from "../ui/McText";
import { NAV, NAV_GROUPS, navItem, subrouteTitle } from "../ui/nav";
import { IconClose, IconLogout, IconMenu } from "../ui/icons";
import { Login } from "../pages/Login";

const OverviewPage = lazy(() => import("../pages/OverviewPage"));
const BuildsPage = lazy(() => import("../pages/BuildsPage"));
const AccountsPage = lazy(() => import("../pages/AccountsPage"));
const CustomizationPage = lazy(() => import("../pages/CustomizationPage"));
const NewsPage = lazy(() => import("../pages/NewsPage"));
const GuidesPage = lazy(() => import("../pages/GuidesPage"));
const LogsPage = lazy(() => import("../pages/LogsPage"));
const ExternalModsPage = lazy(() => import("../pages/ExternalModsPage"));
const SeasonsPage = lazy(() => import("../pages/SeasonsPage"));
const ReleasesPage = lazy(() => import("../pages/ReleasesPage"));
const SettingsPage = lazy(() => import("../pages/SettingsPage"));

const SIDEBAR_KEY = "stardust.admin.sidebar.collapsed";

function readSidebarCollapsed(): boolean {
  try {
    return localStorage.getItem(SIDEBAR_KEY) === "1";
  } catch {
    return false;
  }
}

function writeSidebarCollapsed(collapsed: boolean) {
  try {
    localStorage.setItem(SIDEBAR_KEY, collapsed ? "1" : "0");
  } catch {
    // Не критично.
  }
}

export function App() {
  return (
    <FeedbackProvider>
      <ContextMenuProvider>
        <AuthProvider>
          <Gate />
        </AuthProvider>
      </ContextMenuProvider>
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

  if (!authed) return <Login onLoggedIn={onLoggedIn} />;

  return <Shell />;
}

function Shell() {
  const { username, logout } = useAuth();
  const location = useLocation();
  const meta = sectionDetails(location.pathname);
  const [collapsed, setCollapsed] = useState(readSidebarCollapsed());
  const [drawer, setDrawer] = useState(false);

  // Смена раздела закрывает drawer (мобильный сценарий).
  useEffect(() => {
    setDrawer(false);
  }, [location.pathname]);

  function toggleSidebar() {
    setCollapsed((c) => {
      writeSidebarCollapsed(!c);
      return !c;
    });
  }

  return (
    <div className={`app${collapsed ? " app-collapsed" : ""}`}>
      {drawer && (
        <div className="drawer-backdrop" onClick={() => setDrawer(false)}>
          <aside className="sidebar drawer" onClick={(e) => e.stopPropagation()}>
            <SidebarBody
              username={username}
              onLogout={logout}
              onCloseDrawer={() => setDrawer(false)}
            />
          </aside>
        </div>
      )}

      <aside className="sidebar">
        <SidebarBody
          username={username}
          onLogout={logout}
          onToggle={toggleSidebar}
        />
      </aside>

      <div className="workspace">
        <header className="topbar">
          <button
            type="button"
            className="topbar-menu iconbtn"
            aria-label="Меню"
            onClick={() => setDrawer(true)}
          >
            <IconMenu size={18} />
          </button>
          <div className="topbar-copy">
            <strong>{meta.title}</strong>
            <small>{meta.description}</small>
          </div>
        </header>
        <main className="content">
          <Suspense
            fallback={
              <div className="page-state">
                <span className="spinner spinner-lg" />
                Загрузка…
              </div>
            }
          >
            <Routes>
              <Route path="/overview" element={<OverviewPage />} />
              <Route path="/builds" element={<BuildsPage />} />
              <Route path="/builds/:id" element={<BuildsPage />} />
              <Route path="/builds/new" element={<BuildsPage />} />
              <Route path="/accounts" element={<AccountsPage />} />
              <Route path="/customization" element={<CustomizationPage />} />
              <Route path="/news" element={<NewsPage />} />
              <Route path="/news/:id" element={<NewsPage />} />
              <Route path="/guides" element={<GuidesPage />} />
              <Route path="/guides/:id" element={<GuidesPage />} />
              <Route path="/logs" element={<LogsPage />} />
              <Route path="/mods" element={<ExternalModsPage />} />
              <Route path="/seasons" element={<SeasonsPage />} />
              <Route path="/releases" element={<ReleasesPage />} />
              <Route path="/settings" element={<SettingsPage />} />
              <Route path="*" element={<Navigate to="/overview" replace />} />
            </Routes>
          </Suspense>
        </main>
      </div>
    </div>
  );
}

function SidebarBody({
  username,
  onLogout,
  onToggle,
  onCloseDrawer,
}: {
  username: string | null;
  onLogout: () => void;
  onToggle?: () => void;
  onCloseDrawer?: () => void;
}) {
  return (
    <>
      <div className="brand">
        <img src="/stardust-logo.svg" alt="" />
        <div className="brand-copy">
          <strong>StarDust</strong>
          <small>Панель управления</small>
        </div>
        {onCloseDrawer && (
          <IconButton label="Закрыть меню" size="sm" onClick={onCloseDrawer}>
            <IconClose size={15} />
          </IconButton>
        )}
        {onToggle && (
          <button
            type="button"
            className="sidebar-toggle"
            aria-label="Свернуть меню"
            onClick={onToggle}
          >
            <span />
            <span />
          </button>
        )}
      </div>
      <nav className="nav">
        {NAV_GROUPS.map((group) => (
          <section key={group} aria-label={group}>
            <span className="nav-group">{group}</span>
            {NAV.filter((item) => item.group === group).map((item) => (
              <NavLink
                key={item.tab}
                to={item.route}
                className={({ isActive }) =>
                  `nav-item${isActive ? " nav-active" : ""}`
                }
                title={item.label}
              >
                {item.icon(16)}
                <span className="nav-label">{item.label}</span>
              </NavLink>
            ))}
          </section>
        ))}
      </nav>
      <div className="sidebar-foot">
        {username && (
          <div className="who" title={username}>
            <span className="who-avatar">
              <McText text={Array.from(username)[0]?.toUpperCase() ?? ""} />
            </span>
            <McText className="who-name ellipsis" text={username} />
          </div>
        )}
        <button type="button" className="nav-item" onClick={onLogout}>
          <IconLogout size={16} />
          <span className="nav-label">Выйти</span>
        </button>
      </div>
    </>
  );
}

/** Заголовок и описание текущего раздела для топбара. */
function sectionDetails(pathname: string): { title: string; description: string } {
  const section = pathname.split("/")[1] || "overview";
  const item = navItem(section);
  const sub = subrouteTitle(pathname);
  return {
    title: sub ?? (item.tab === "overview" ? "Панель управления" : item.label),
    description: item.description,
  };
}
