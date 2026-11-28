import React from "react";
import ReactDOM from "react-dom/client";
import { createBrowserRouter, RouterProvider } from "react-router-dom";
import { DesktopApp } from "./desktop/DesktopApp";
import { DashboardShell } from "./ui/DashboardShell";
import { DashboardView } from "./views/DashboardView";
import { redirectIfWrongView } from "./app/viewMode";
import { reloadOnStaleChunk } from "./app/staleChunks";
import "./styles.css";

// Деплой сменил чанки под открытой вкладкой — тихо перезагружаемся
// вместо красного экрана «error loading dynamically imported module».
reloadOnStaleChunk();

// Телефон на десктопном URL — уводим на /m. Если редиректим, рендерить не нужно.
//
// Data-роутер (а не BrowserRouter) нужен для useBlocker: dirty-guard
// маршрутов-редакторов (/news/:id, /guides/:id) перехватывает SPA-навигацию
// и жёсткую перезагрузку, чтобы черновик не исчезал молча. Само дерево
// маршрутов живёт в DesktopApp (Routes) — здесь только корневая обёртка.
// Новый шелл admin-v2 (этап 1): пока только дашборд. «/» остаётся на
// старом /overview — переключим после переноса остальных экранов.
const router = createBrowserRouter([
  {
    path: "/dashboard",
    element: (
      <DashboardShell
        title="Дашборд"
        subtitle="Состояние сервера, игроков, сборок и инфраструктуры на одном экране."
      >
        <DashboardView />
      </DashboardShell>
    ),
  },
  { path: "*", element: <DesktopApp /> },
]);

if (!redirectIfWrongView("desktop")) {
  ReactDOM.createRoot(document.getElementById("root")!).render(
    <React.StrictMode>
      <RouterProvider router={router} />
    </React.StrictMode>,
  );
}
