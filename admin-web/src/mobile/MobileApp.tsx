// Мобильная оболочка админки (/m): нижняя навигация вместо боковой панели,
// экраны на всю ширину, крупные тач-цели. Слой данных (api/типы) общий с
// десктопом — отличается только презентация, заточенная под телефон.

import { NavLink, Navigate, Route, Routes } from "react-router-dom";
import { FeedbackProvider } from "../ui/feedback";
import { AuthProvider, useAuth } from "../app/useAuth";
import { MobileLogin } from "./MobileLogin";
import { MobileOverview } from "./MobileOverview";
import { MobileBuilds } from "./MobileBuilds";
import { MobileBuildDetail } from "./MobileBuildDetail";
import { MobileAccounts } from "./MobileAccounts";
import { MobileSettings } from "./MobileSettings";
import { MobileCustomization } from "./MobileCustomization";
import { IconBox, IconChart, IconLogout, IconSettings, IconStar, IconUsers } from "../ui/icons";
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

const NAV = [
  { to: "/overview", label: "Обзор", icon: <IconChart size={21} /> },
  { to: "/builds", label: "Сборки", icon: <IconBox size={22} /> },
  { to: "/accounts", label: "Аккаунты", icon: <IconUsers size={22} /> },
  { to: "/customization", label: "Косметика", icon: <IconStar size={21} /> },
  { to: "/settings", label: "Система", icon: <IconSettings size={22} /> },
];

function Shell() {
  const { logout } = useAuth();
  return (
    <div className="m-app">
      <header className="m-shell-head">
        <div className="m-shell-brand">
          <span className="m-brand-mark"><span /></span>
          <div>
            <strong>StarDust</strong>
            <small>Control room</small>
          </div>
        </div>
        <div className="m-shell-actions">
          <a className="m-shell-link" href={switchViewHref("desktop")}>Desktop</a>
          <button className="icon-only m-shell-logout" title="Выйти" onClick={logout}>
            <IconLogout size={17} />
          </button>
        </div>
      </header>
      <main className="m-content">
        <Routes>
          <Route path="/overview" element={<MobileOverview />} />
          <Route path="/builds" element={<MobileBuilds />} />
          <Route path="/builds/:id" element={<MobileBuildDetail />} />
          <Route path="/accounts" element={<MobileAccounts />} />
          <Route path="/customization" element={<MobileCustomization />} />
          <Route path="/settings" element={<MobileSettings />} />
          <Route path="*" element={<Navigate to="/overview" replace />} />
        </Routes>
      </main>
      <nav className="m-tabbar">
        {NAV.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            className={({ isActive }) =>
              `m-tab${isActive ? " active" : ""}`
            }
          >
            {item.icon}
            <span>{item.label}</span>
          </NavLink>
        ))}
      </nav>
    </div>
  );
}
