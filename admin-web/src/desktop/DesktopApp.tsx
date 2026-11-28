// Контентная часть старой десктопной админки (admin-v2, этап 2).
//
// Раньше здесь жил и сайдбар, и топбар, и роуты. Теперь оболочка одна —
// DashboardShell (ui/DashboardShell.tsx): его сайдбар виден на всех экранах,
// а этот компонент рендерит только провайдеры обратной связи/контекстного
// меню и таблицу маршрутов. Авторизация (сессия, Login, logout) тоже живёт
// в шелле — здесь она не дублируется.
//
// Роутер — data-роутер (createBrowserRouter в main.tsx): он нужен для
// useBlocker — dirty-guard маршрутов-редакторов перехватывает уход по
// сайдбару/Back и спрашивает подтверждение, а не молча стирает черновик.
//
// Старый /logs оставлен как был; новый единый журнал — /events (EventsView).

import { lazy, Suspense } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import { FeedbackProvider } from "../ui/feedback";
import { ContextMenuProvider } from "../ui/ContextMenu";
import { DashboardView } from "../views/DashboardView";

const AccountsView = lazy(() => import("../views/AccountsView").then(({ AccountsView }) => ({ default: AccountsView })));
const CustomizationView = lazy(() => import("../views/CustomizationView").then(({ CustomizationView }) => ({ default: CustomizationView })));
const ExternalModsView = lazy(() => import("../views/ExternalModsView").then(({ ExternalModsView }) => ({ default: ExternalModsView })));
const GuidesView = lazy(() => import("../views/GuidesView").then(({ GuidesView }) => ({ default: GuidesView })));
const LogsView = lazy(() => import("../views/LogsView").then(({ LogsView }) => ({ default: LogsView })));
const NewsView = lazy(() => import("../views/NewsView").then(({ NewsView }) => ({ default: NewsView })));
const OverviewView = lazy(() => import("../views/OverviewView").then(({ OverviewView }) => ({ default: OverviewView })));
const ReleasesView = lazy(() => import("../views/ReleasesView").then(({ ReleasesView }) => ({ default: ReleasesView })));
const SeasonsView = lazy(() => import("../views/SeasonsView").then(({ SeasonsView }) => ({ default: SeasonsView })));
const SettingsView = lazy(() => import("../views/SettingsView").then(({ SettingsView }) => ({ default: SettingsView })));
const EventsView = lazy(() => import("../views/EventsView").then(({ EventsView }) => ({ default: EventsView })));
const BuildsPage = lazy(() => import("./BuildsPage").then(({ BuildsPage }) => ({ default: BuildsPage })));

export function DesktopAppContent() {
  return (
    <FeedbackProvider>
      <ContextMenuProvider>
        <Suspense
          fallback={
            <div className="view muted pad">
              <span className="spinner" />
              Загрузка раздела…
            </div>
          }
        >
          <Routes>
            <Route path="/dashboard" element={<DashboardView />} />
            <Route path="/overview" element={<OverviewView />} />
            <Route path="/builds" element={<BuildsPage />} />
            <Route path="/builds/:id" element={<BuildsPage />} />
            <Route path="/accounts" element={<AccountsView />} />
            <Route path="/customization" element={<CustomizationView />} />
            {/* Редакторы новостей/гайдов — маршруты (план 3.6): NewsView и
                GuidesView сами различают индекс и подмаршрут по useParams,
                dirty-guard черновика сохранён (useRouteGuard). */}
            <Route path="/news" element={<NewsView />} />
            <Route path="/news/:id" element={<NewsView />} />
            <Route path="/guides" element={<GuidesView />} />
            <Route path="/guides/:id" element={<GuidesView />} />
            <Route path="/logs" element={<LogsView />} />
            <Route path="/events" element={<EventsView />} />
            <Route path="/mods" element={<ExternalModsView />} />
            <Route path="/seasons" element={<SeasonsView />} />
            <Route path="/releases" element={<ReleasesView />} />
            <Route path="/settings" element={<SettingsView />} />
            <Route path="*" element={<Navigate to="/dashboard" replace />} />
          </Routes>
        </Suspense>
      </ContextMenuProvider>
    </FeedbackProvider>
  );
}
