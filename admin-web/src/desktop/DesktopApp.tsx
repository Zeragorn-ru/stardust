// Десктопная оболочка админки на основе маршрутизатора.
//
// Навигация переехала с локального состояния вкладок на реальные маршруты
// (react-router): теперь у каждого экрана свой URL, работают «назад/вперёд»,
// открытая сборка адресуется ссылкой `/builds/:id`. Слой данных (api/типы) и
// проверенная логика управления файлами переиспользуются как есть.

import { useCallback, useEffect, useState } from "react";
import { NavLink, Navigate, Route, Routes, useLocation } from "react-router-dom";
import { FeedbackProvider } from "../ui/feedback";
import { AuthProvider, useAuth } from "../app/useAuth";
import { Login } from "../Login";
import { BuildsPage } from "./BuildsPage";
import { AccountsView } from "../views/AccountsView";
import { SettingsView } from "../views/SettingsView";
import { CustomizationView } from "../views/CustomizationView";
import { IconBox, IconLogout, IconSettings, IconSmartphone, IconUsers, IconStar, IconPlus } from "../ui/icons";
import { switchViewHref } from "../app/viewMode";
import { api } from "../api";
import type { BuildHeader } from "../types";

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

function Shell() {
  const { username, logout } = useAuth();
  const location = useLocation();
  const [builds, setBuilds] = useState<BuildHeader[]>([]);

  const loadBuilds = useCallback(async () => {
    try {
      const list = await api.listBuilds();
      setBuilds(list);
    } catch {}
  }, []);

  useEffect(() => {
    loadBuilds();
    window.addEventListener("builds-updated", loadBuilds);
    return () => window.removeEventListener("builds-updated", loadBuilds);
  }, [loadBuilds]);

  const onBuildsRoute = location.pathname.startsWith("/builds");

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-dot" />
          StarDust
        </div>
        <nav className="nav">
          <NavLink
            to="/builds"
            className={({ isActive }) =>
              `nav-item${isActive ? " active" : ""}`
            }
          >
            <IconBox /> Сборки
          </NavLink>

          {onBuildsRoute && (
            <div className="sidebar-sub-nav">
              {builds.map((b) => (
                <NavLink
                  key={b.id}
                  to={`/builds/${b.id}`}
                  className={({ isActive }) =>
                    `sub-nav-item${isActive ? " active" : ""}`
                  }
                >
                  <span className="sub-nav-text" title={b.name}>
                    {b.name}
                  </span>
                  {b.isActive && (
                    <IconStar size={10} className="sub-nav-star" />
                  )}
                </NavLink>
              ))}
              <NavLink
                to="/builds/new"
                className={({ isActive }) =>
                  `sub-nav-item sub-nav-add-btn${isActive ? " active" : ""}`
                }
              >
                <IconPlus size={12} />
                <span>Создать</span>
              </NavLink>
            </div>
          )}

          <NavLink
            to="/accounts"
            className={({ isActive }) =>
              `nav-item${isActive ? " active" : ""}`
            }
          >
            <IconUsers /> Аккаунты
          </NavLink>
          <NavLink
            to="/customization"
            className={({ isActive }) =>
              `nav-item${isActive ? " active" : ""}`
            }
          >
            <span style={{ fontSize: 16 }}>🎨</span> Кастомизация
          </NavLink>
          <NavLink
            to="/settings"
            className={({ isActive }) =>
              `nav-item${isActive ? " active" : ""}`
            }
          >
            <IconSettings /> Настройки
          </NavLink>
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
          <a className="nav-item" href={switchViewHref("mobile")}>
            <IconSmartphone /> Телефонная версия
          </a>
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
          <Route path="/customization" element={<CustomizationView />} />
          <Route path="/settings" element={<SettingsView />} />
          <Route path="*" element={<Navigate to="/builds" replace />} />
        </Routes>
      </main>
    </div>
  );
}
