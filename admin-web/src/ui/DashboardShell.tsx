// DashboardShell — новая оболочка админки (admin-v2, этап 1).
//
// Используется только маршрутом /dashboard; старый DesktopApp не тронут —
// остальные маршруты живут в нём, и переход по ним из этого сайдбара
// просто уводит в старый шелл, пока экраны не переведены на kit.
//
// Сайдбар 220px, первый пункт — «Дашборд». Имена/иконки остальных пунктов
// берутся из ui/navConfig, чтобы не плодить четвёртую копию навигации.

import { NavLink } from "react-router-dom";
import type { ReactNode } from "react";
import { AuthProvider, useAuth } from "../app/useAuth";
import { Login } from "../Login";
import { NAV, NAV_GROUPS } from "./navConfig";
import { IconChart, IconLogout } from "./icons";
import { McText } from "./McText";

export interface DashboardShellProps {
  title: ReactNode;
  subtitle?: ReactNode;
  children: ReactNode;
}

export function DashboardShell({ title, subtitle, children }: DashboardShellProps) {
  return (
    <AuthProvider>
      <Gate title={title} subtitle={subtitle}>
        {children}
      </Gate>
    </AuthProvider>
  );
}

function Gate({ title, subtitle, children }: DashboardShellProps) {
  const { authed, onLoggedIn } = useAuth();

  if (authed === null) {
    return (
      <div className="kit-shell">
        <div className="login-wrap muted">
          <span className="spinner" />
          Проверка сессии…
        </div>
      </div>
    );
  }

  if (!authed) return <Login onLoggedIn={onLoggedIn} />;

  return (
    <Shell title={title} subtitle={subtitle}>
      {children}
    </Shell>
  );
}

function Shell({ title, subtitle, children }: DashboardShellProps) {
  const { username, logout } = useAuth();

  return (
    <div className="kit-shell">
      <div className="kit-shell-body">
        <aside className="kit-sidebar">
          <div className="kit-brand">
            <img src="/stardust-logo.svg?v=palette-lunar" alt="" />
            <strong>StarDust</strong>
          </div>
          <nav className="kit-nav" aria-label="Навигация админки">
            <NavLink to="/dashboard" className={({ isActive }) => `kit-nav-item${isActive ? " active" : ""}`}>
              <IconChart size={16} /> Дашборд
            </NavLink>
            {NAV_GROUPS.map((group) => (
              <section key={group} aria-label={group}>
                <span className="kit-nav-group">{group}</span>
                {NAV.filter((item) => item.group === group).map((item) => (
                  <NavLink
                    key={item.tab}
                    to={item.route}
                    className={({ isActive }) => `kit-nav-item${isActive ? " active" : ""}`}
                  >
                    {item.icon(16)} <span className="nav-label">{item.label}</span>
                  </NavLink>
                ))}
              </section>
            ))}
          </nav>
          <div className="kit-sidebar-foot">
            {username && (
              <div className="kit-nav-item" title={username}>
                <McText text={Array.from(username)[0]?.toUpperCase() ?? ""} />
                <McText text={username} />
              </div>
            )}
            <button type="button" className="kit-nav-item" onClick={logout}>
              <IconLogout size={16} /> Выйти
            </button>
          </div>
        </aside>
        <main className="kit-shell-main">
          <h1 className="kit-shell-title">{title}</h1>
          {subtitle && <p className="kit-shell-subtitle">{subtitle}</p>}
          {children}
        </main>
      </div>
    </div>
  );
}
