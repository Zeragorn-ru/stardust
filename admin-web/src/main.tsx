import React from "react";
import ReactDOM from "react-dom/client";
import { createBrowserRouter, RouterProvider } from "react-router-dom";
import { DesktopApp } from "./desktop/DesktopApp";
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
const router = createBrowserRouter([{ path: "*", element: <DesktopApp /> }]);

if (!redirectIfWrongView("desktop")) {
  ReactDOM.createRoot(document.getElementById("root")!).render(
    <React.StrictMode>
      <RouterProvider router={router} />
    </React.StrictMode>,
  );
}
