import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { MobileApp } from "./MobileApp";
import { redirectIfWrongView } from "../app/viewMode";
import "../styles.css";
import "./mobile.css";

// Десктоп на мобильном URL — уводим на /. Если редиректим, рендерить не нужно.
// Мобильный интерфейс раздаётся под /m/, поэтому маршрутизатору задаём базовый
// путь — ссылки и история работают относительно него.
if (!redirectIfWrongView("mobile")) {
  ReactDOM.createRoot(document.getElementById("root")!).render(
    <React.StrictMode>
      <BrowserRouter basename="/m">
        <MobileApp />
      </BrowserRouter>
    </React.StrictMode>,
  );
}
