// Мобильная оболочка админки (/m): нижняя навигация вместо боковой панели,
// экраны на всю ширину, крупные тач-цели. Слой данных (api/типы) общий с
// десктопом — отличается только презентация, заточенная под телефон.

import { NavLink, Navigate, Route, Routes } from "react-router-dom";
import { FeedbackProvider } from "../ui/feedback";
import { AuthProvider, useAuth } from "../app/useAuth";
import { MobileLogin } from "./MobileLogin";
import { MobileBuilds } from "./MobileBuilds";
import { MobileBuildDetail } from "./MobileBuildDetail";
import { MobileAccounts } from "./MobileAccounts";
import { MobileSettings } from "./MobileSettings";
import { IconBox, IconSettings, IconUsers } from "../ui/icons";

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
  { to: "/builds", label: "Сборки", icon: <IconBox size={22} /> },
  { to: "/accounts", label: "Аккаунты", icon: <IconUsers size={22} /> },
  { to: "/settings", label: "Настройки", icon: <IconSettings size={22} /> },
];

function Shell() {
  return (
    <div className="m-app">
      <main className="m-content">
        <Routes>
          <Route path="/builds" element={<MobileBuilds />} />
          <Route path="/builds/:id" element={<MobileBuildDetail />} />
          <Route path="/accounts" element={<MobileAccounts />} />
          <Route path="/settings" element={<MobileSettings />} />
          <Route path="*" element={<Navigate to="/builds" replace />} />
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
