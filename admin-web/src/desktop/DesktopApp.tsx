// Десктопная оболочка админки на основе маршрутизатора.
//
// Навигация переехала с локального состояния вкладок на реальные маршруты
// (react-router): теперь у каждого экрана свой URL, работают «назад/вперёд»,
// открытая сборка адресуется ссылкой `/builds/:id`. Слой данных (api/типы) и
// проверенная логика управления файлами переиспользуются как есть.

import { useState } from "react";
import { NavLink, Navigate, Route, Routes, useLocation } from "react-router-dom";
import { FeedbackProvider } from "../ui/feedback";
import { AuthProvider, useAuth } from "../app/useAuth";
import { Login } from "../Login";
import { BuildsPage } from "./BuildsPage";
import { OverviewView } from "../views/OverviewView";
import { AccountsView } from "../views/AccountsView";
import { SettingsView } from "../views/SettingsView";
import { CustomizationView } from "../views/CustomizationView";
import { IconBox, IconChart, IconLogout, IconSettings, IconSmartphone, IconStar, IconUsers } from "../ui/icons";
import { switchViewHref } from "../app/viewMode";

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
  const section = location.pathname.split("/")[1] || "overview";
  const [sidebarOpen, setSidebarOpen] = useState(true);

  return (
    <div className={`app${sidebarOpen ? "" : " sidebar-collapsed"}`}>
      <aside className="sidebar">
        <div className="brand brand-redesigned">
          <span className="brand-mark">
            <span />
          </span>
          <div className="brand-copy">
            <strong>StarDust</strong>
            <small>Control room</small>
          </div>
          <button
            className="sidebar-toggle"
            type="button"
            aria-label={sidebarOpen ? "Свернуть меню" : "Развернуть меню"}
            aria-expanded={sidebarOpen}
            onClick={() => setSidebarOpen((open) => !open)}
          >
            <span />
            <span />
            <span />
          </button>
        </div>
        <nav className="nav">
          <span className="nav-group">Overview</span>
          <NavLink
            to="/overview"
            className={({ isActive }) =>
              `nav-item${isActive ? " active" : ""}`
            }
          >
            <IconChart /> <span className="nav-label">Обзор</span>
          </NavLink>
          <span className="nav-group">Infrastructure</span>
          <NavLink
            to="/builds"
            className={({ isActive }) =>
              `nav-item${isActive ? " active" : ""}`
            }
          >
            <IconBox /> <span className="nav-label">Сборки</span>
          </NavLink>
          <NavLink
            to="/settings"
            className={({ isActive }) =>
              `nav-item${isActive ? " active" : ""}`
            }
          >
            <IconSettings /> <span className="nav-label">Интеграции</span>
          </NavLink>
          <span className="nav-group">Operations</span>
          <NavLink
            to="/accounts"
            className={({ isActive }) =>
              `nav-item${isActive ? " active" : ""}`
            }
          >
            <IconUsers /> <span className="nav-label">Аккаунты</span>
          </NavLink>
          <NavLink
            to="/customization"
            className={({ isActive }) =>
              `nav-item${isActive ? " active" : ""}`
            }
          >
            <IconStar /> <span className="nav-label">Кастомизация</span>
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
            <IconSmartphone /> <span className="nav-label">Телефонная версия</span>
          </a>
          <button className="nav-item" onClick={logout}>
            <IconLogout /> <span className="nav-label">Выйти</span>
          </button>
        </div>
      </aside>
      <div className="workspace">
        <header className="topbar">
          <div>
            <span className="topbar-eyebrow">/{section}</span>
            <strong>{sectionTitle(section)}</strong>
          </div>
          <div className="topbar-status">
            <span className="status-dot status-dot--online" />
            API connected
          </div>
        </header>
        <main className="content">
          <Routes>
            <Route path="/overview" element={<OverviewView />} />
            <Route path="/builds" element={<BuildsPage />} />
            <Route path="/builds/:id" element={<BuildsPage />} />
            <Route path="/accounts" element={<AccountsView />} />
            <Route path="/customization" element={<CustomizationView />} />
            <Route path="/settings" element={<SettingsView />} />
            <Route path="*" element={<Navigate to="/overview" replace />} />
          </Routes>
        </main>
      </div>
    </div>
  );
}

function sectionTitle(section: string): string {
  switch (section) {
    case "builds":
      return "Сборки и файлы";
    case "accounts":
      return "Игроки и доступ";
    case "customization":
      return "Косметика";
    case "settings":
      return "Инфраструктура";
    default:
      return "Панель управления";
  }
}
