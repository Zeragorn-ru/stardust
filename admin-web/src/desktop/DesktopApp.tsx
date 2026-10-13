// Десктопная оболочка админки на основе маршрутизатора.
//
// Навигация переехала с локального состояния вкладок на реальные маршруты
// (react-router): теперь у каждого экрана свой URL, работают «назад/вперёд»,
// открытая сборка адресуется ссылкой `/builds/:id`, редакторы новостей и
// гайдов — `/news/:id|new` и `/guides/:id|new`. Слой данных (api/типы) и
// проверенная логика управления файлами переиспользуются как есть.
//
// Роутер — data-роутер (createBrowserRouter в main.tsx): он нужен для
// useBlocker — dirty-guard маршрутов-редакторов перехватывает уход по
// сайдбару/Back и спрашивает подтверждение, а не молча стирает черновик.
//
// Сайдбар и заголовок топбара рендерятся из единой таблицы ui/navConfig —
// рассинхронизация имён/иконок между сайдбаром и топбаром невозможна.
// Свёрнутое состояние сайдбара запоминается в localStorage (как выбор
// интерфейса и фильтры аккаунтов) и переживает перезагрузку страницы.

import { useState } from "react";
import { NavLink, Navigate, Route, Routes, useLocation } from "react-router-dom";
import { FeedbackProvider } from "../ui/feedback";
import { ContextMenuProvider } from "../ui/ContextMenu";
import { AuthProvider, useAuth } from "../app/useAuth";
import { Login } from "../Login";
import { BuildsPage } from "./BuildsPage";
import { OverviewView } from "../views/OverviewView";
import { AccountsView } from "../views/AccountsView";
import { SettingsView } from "../views/SettingsView";
import { CustomizationView } from "../views/CustomizationView";
import { NewsView } from "../views/NewsView";
import { GuidesView } from "../views/GuidesView";
import { LogsView } from "../views/LogsView";
import { ExternalModsView } from "../views/ExternalModsView";
import { SeasonsView } from "../views/SeasonsView";
import { NAV, NAV_GROUPS, navItem, subrouteTitle } from "../ui/navConfig";
import { IconLogout, IconSmartphone } from "../ui/icons";
import { switchViewHref } from "../app/viewMode";

const SIDEBAR_STORAGE_KEY = "stardust.admin.sidebar.collapsed";

function readSidebarCollapsed(): boolean {
  try {
    return localStorage.getItem(SIDEBAR_STORAGE_KEY) === "1";
  } catch {
    // Приватный режим/заблокированное хранилище — просто стартуем развёрнутым.
    return false;
  }
}

function writeSidebarCollapsed(collapsed: boolean) {
  try {
    localStorage.setItem(SIDEBAR_STORAGE_KEY, collapsed ? "1" : "0");
  } catch {
    // Не запоминаем — это только удобство, не данные.
  }
}

export function DesktopApp() {
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
  const sectionMeta = sectionDetails(location.pathname);
  const [sidebarOpen, setSidebarOpen] = useState(!readSidebarCollapsed());

  function toggleSidebar() {
    setSidebarOpen((open) => {
      writeSidebarCollapsed(open);
      return !open;
    });
  }

  return (
    <div className={`app${sidebarOpen ? "" : " sidebar-collapsed"}`}>
      <aside className="sidebar">
        <div className="brand brand-redesigned">
          <span className="brand-mark">
            <span />
          </span>
          <div className="brand-copy">
            <strong>StarDust</strong>
            <small>Панель управления</small>
          </div>
          <button
            className="sidebar-toggle"
            type="button"
            aria-label={sidebarOpen ? "Свернуть меню" : "Развернуть меню"}
            aria-expanded={sidebarOpen}
            onClick={toggleSidebar}
          >
            <span />
            <span />
            <span />
          </button>
        </div>
        {/* Единая таблица навигации (ui/navConfig): группы и пункты
            рендерятся в порядке из таблицы, имена/иконки совпадают с
            мобильным drawer и топбаром по построению. */}
        <nav className="nav">
          {NAV_GROUPS.map((group) => (
            <section key={group} aria-label={group}>
              <span className="nav-group">{group}</span>
              {NAV.filter((item) => item.group === group).map((item) => (
                <NavLink
                  key={item.tab}
                  to={item.route}
                  className={({ isActive }) =>
                    `nav-item${isActive ? " active" : ""}`
                  }
                >
                  {item.icon(16)} <span className="nav-label">{item.label}</span>
                </NavLink>
              ))}
            </section>
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
          <a className="nav-item" href={switchViewHref("mobile")}>
            <IconSmartphone /> <span className="nav-label">Мобильная версия</span>
          </a>
          <button className="nav-item" onClick={logout}>
            <IconLogout /> <span className="nav-label">Выйти</span>
          </button>
        </div>
      </aside>
      <div className="workspace">
        <header className="topbar">
          <div className="topbar-copy">
            <strong>{sectionMeta.title}</strong>
            <small className="topbar-description">{sectionMeta.description}</small>
          </div>
          <div className="topbar-actions">
            <a className="topbar-view-link" href={switchViewHref("mobile")}>Открыть мобильную версию</a>
            {username && (
              <div className="topbar-status" aria-label="Текущий пользователь">
                <span className="status-dot status-dot--online" />
                {username}
              </div>
            )}
          </div>
        </header>
        <main className="content">
          <Routes>
            <Route path="/overview" element={<OverviewView />} />
            <Route path="/builds" element={<BuildsPage />} />
            <Route path="/builds/:id" element={<BuildsPage />} />
            <Route path="/accounts" element={<AccountsView />} />
            <Route path="/customization" element={<CustomizationView />} />
            {/* Редакторы новостей/гайдов — маршруты (план 3.6): NewsView и
                GuidesView сами различают индекс и подмаршрут по useParams. */}
            <Route path="/news" element={<NewsView />} />
            <Route path="/news/:id" element={<NewsView />} />
            <Route path="/guides" element={<GuidesView />} />
            <Route path="/guides/:id" element={<GuidesView />} />
            <Route path="/logs" element={<LogsView />} />
            <Route path="/mods" element={<ExternalModsView />} />
            <Route path="/seasons" element={<SeasonsView />} />
            <Route path="/settings" element={<SettingsView />} />
            <Route path="*" element={<Navigate to="/overview" replace />} />
          </Routes>
        </main>
      </div>
    </div>
  );
}

/**
 * Заголовок и описание текущего раздела для топбара (план 2.1/2.5).
 *
 * Канонические имена берутся из NAV — секция switch с четырьмя вариантами
 * одного имени («Интеграции»/«Инфраструктура»/«Система») упразднена. Для
 * подмаршрутов (`/builds/:id`, `/builds/new`, а в будущем `/news/:id|new`,
 * `/guides/:id|new`) вместо индексного названия подставляется заголовок
 * подмаршрута. Описание подмаршрута наследуется от раздела: топбар остаётся
 * контекстным, а не дублирует заголовок, который экран рисует сам.
 */
function sectionDetails(pathname: string): { title: string; description: string } {
  const section = pathname.split("/")[1] || "overview";
  const item = navItem(section);
  const sub = subrouteTitle(pathname);
  return {
    title: sub ?? (item.tab === "overview" ? "Панель управления" : item.label),
    description: item.description,
  };
}
