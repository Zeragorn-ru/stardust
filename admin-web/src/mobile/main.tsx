import React from "react";
import ReactDOM from "react-dom/client";
import { MobileApp } from "./MobileApp";
import { redirectIfWrongView } from "../app/viewMode";
import { reloadOnStaleChunk } from "../app/staleChunks";
import "../styles.css";
import "./mobile.css";

// Деплой сменил чанки под открытой вкладкой — тихо перезагружаемся
// вместо красного экрана «error loading dynamically imported module».
reloadOnStaleChunk();

// Десктоп на мобильном URL — уводим на /. Если редиректим, рендерить не нужно.
// Мобильный интерфейс — single-page web app: вкладки меняются состоянием React,
// без pushState и переходов, чтобы iOS standalone не открывал новые страницы.
if (!redirectIfWrongView("mobile")) {
  ReactDOM.createRoot(document.getElementById("root")!).render(
    <React.StrictMode>
      <MobileApp />
    </React.StrictMode>,
  );
}
