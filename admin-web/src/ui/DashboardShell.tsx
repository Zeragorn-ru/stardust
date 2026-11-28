// DashboardShell — единая оболочка админки (admin-v2, этап 2).
//
// С этого этапа сайдбар общий для ВСЕХ экранов: маршрут «*» в main.tsx
// рендерит шелл, внутри которого DesktopAppContent рисует содержимое
// раздела. Старый сайдбар/топбар DesktopApp убран; авторизация (сессия,
// Login, logout) живёт здесь в одном экземпляре.
//
// Сайдбар 220px, первый пункт — «Дашборд». Имена/иконки остальных пунктов
// берутся из ui/navConfig, чтобы не плодить четвёртую копию навигации.
// «Журнал» (/events) — новый экран admin-v2, в общую NAV-таблицу не добавлен:
// она разделяется с мобильным drawer, у которого этого экрана нет.
//
// Заголовок и подпись шелла вычисляются по текущему URL из той же NAV
// (включая подмаршруты редакторов через subrouteTitle).

import { NavLink, useLocation } from "react-router-dom";
import type { ReactNode } from "react";
import { AuthProvider, useAuth } from "../app/useAuth";
import { Login } from "../Login";
import { NAV, NAV_GROUPS, navItem, subrouteTitle } from "./navConfig";
import { IconChart, IconLogout, IconTerminal } from "./icons";
import { McText } from "./McText";

export function DashboardShell({ children }: { children: ReactNode }) {
  return (
    <AuthProvider>
      <Gate>{children}</Gate>
    </AuthProvider>
  );
}

function Gate({ children }: { children: ReactNode }) {
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

  return <Shell>{children}</Shell>;
}

function Shell({ children }: { children: ReactNode }) {
  const { username, logout } = useAuth();
  const location = useLocation();
  const meta = shellHeading(location.pathname);

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
                {groupItems(group).map((item) => (
                  <NavLink
                    key={item.route}
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
          <h1 className="kit-shell-title">{meta.title}</h1>
          {meta.subtitle && <p className="kit-shell-subtitle">{meta.subtitle}</p>}
          {children}
        </main>
      </div>
    </div>
  );
}

/**
 * Пункты сайдбара группы: элементы NAV этой группы плюс служебные
 * admin-v2-экраны. «Журнал» (/events) встаёт в «Мониторинг» рядом со
 * старым «Логи».
 */
function groupItems(group: string): { route: string; label: string; icon: (size: number) => ReactNode }[] {
  const items = NAV.filter((item) => item.group === group).map((item) => ({
    route: item.route,
    label: item.label,
    icon: item.icon,
  }));
  if (group === "Мониторинг") {
    items.push({ route: "/events", label: "Журнал", icon: (size) => <IconTerminal size={size} /> });
  }
  return items;
}

/**
 * Заголовок и подпись шелла по текущему маршруту.
 *
 * Канонические имена — из NAV; для подмаршрутов (/builds/:id, /news/:id|new,
 * /guides/:id|new) заголовок подставляет subrouteTitle. Дашборд и журнал —
 * собственные подписи: их нет в NAV, которую разделяет мобильный шелл.
 */
function shellHeading(pathname: string): { title: string; subtitle?: string } {
  if (pathname === "/" || pathname.startsWith("/dashboard")) {
    return {
      title: "Дашборд",
      subtitle: "Состояние сервера, игроков, сборок и инфраструктуры на одном экране.",
    };
  }
  if (pathname.startsWith("/events")) {
    return {
      title: "Журнал",
      subtitle: "Единый журнал событий сервера: входы, выходы, чужие моды и краши.",
    };
  }
  const section = pathname.split("/")[1] || "overview";
  const item = navItem(section);
  const sub = subrouteTitle(pathname);
  return {
    title: sub ?? (item.tab === "overview" ? "Панель управления" : item.label),
    subtitle: item.description,
  };
}
