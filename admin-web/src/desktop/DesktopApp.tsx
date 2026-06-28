// Десктопная оболочка админки на основе маршрутизатора.
//
// Навигация переехала с локального состояния вкладок на реальные маршруты
// (react-router): теперь у каждого экрана свой URL, работают «назад/вперёд»,
// открытая сборка адресуется ссылкой `/builds/:id`. Слой данных (api/типы) и
// проверенная логика управления файлами переиспользуются как есть.

import { NavLink, Navigate, Route, Routes } from "react-router-dom";
import { FeedbackProvider } from "../ui/feedback";
import { AuthProvider, useAuth } from "../app/useAuth";
import { Login } from "../Login";
import { BuildsPage } from "./BuildsPage";
import { AccountsView } from "../views/AccountsView";
import { SettingsView } from "../views/SettingsView";
import { IconBox, IconLogout, IconSettings, IconUsers } from "../ui/icons";

export function DesktopApp() {
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

  if (!authed) return <Login onLoggedIn={onLoggedIn} />;

  return <Shell />;
}

const NAV = [
  { to: "/builds", label: "Сборки", icon: <IconBox /> },
  { to: "/accounts", label: "Аккаунты", icon: <IconUsers /> },
  { to: "/settings", label: "Настройки", icon: <IconSettings /> },
];

function Shell() {
  const { username, logout } = useAuth();

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-dot" />
          StarDust
        </div>
        <nav className="nav">
          {NAV.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              className={({ isActive }) =>
                `nav-item${isActive ? " active" : ""}`
              }
            >
              {item.icon} {item.label}
            </NavLink>
          ))}
        </nav>
        <div className="sidebar-foot">
          {username && (
            <div className="who" title={username}>
              <span className="who-avatar">
                {username.charAt(0).toUpperCase()}
              </span>
              <span className="who-name">{username}</span>
            </div>
          )}
          <button className="nav-item" onClick={logout}>
            <IconLogout /> Выйти
          </button>
        </div>
      </aside>
      <main className="content">
        <Routes>
          <Route path="/builds" element={<BuildsPage />} />
          <Route path="/builds/:id" element={<BuildsPage />} />
          <Route path="/accounts" element={<AccountsView />} />
          <Route path="/settings" element={<SettingsView />} />
          <Route path="*" element={<Navigate to="/builds" replace />} />
        </Routes>
      </main>
    </div>
  );
}
