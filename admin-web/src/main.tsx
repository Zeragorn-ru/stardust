import React from "react";
import ReactDOM from "react-dom/client";
import { createBrowserRouter, RouterProvider } from "react-router-dom";
import { App } from "./shell/App";
import { reloadOnStaleChunk } from "./app/staleChunks";
import "./styles/tokens.css";
import "./styles/base.css";
import "./styles/primitives.css";
import "./styles/shell.css";
import "./styles/features.css";

// Деплой сменил чанки под открытой вкладкой — тихо перезагружаемся.
reloadOnStaleChunk();

// Data-роутер нужен для useBlocker: dirty-guard маршрутов-редакторов
// перехватывает уход с несохранённым черновиком.
const router = createBrowserRouter([{ path: "*", element: <App /> }]);

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <RouterProvider router={router} />
  </React.StrictMode>,
);
