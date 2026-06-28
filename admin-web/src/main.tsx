import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { DesktopApp } from "./desktop/DesktopApp";
import { redirectIfWrongView } from "./app/viewMode";
import "./styles.css";

// Телефон на десктопном URL — уводим на /m. Если редиректим, рендерить не нужно.
if (!redirectIfWrongView("desktop")) {
  ReactDOM.createRoot(document.getElementById("root")!).render(
    <React.StrictMode>
      <BrowserRouter>
        <DesktopApp />
      </BrowserRouter>
    </React.StrictMode>,
  );
}
