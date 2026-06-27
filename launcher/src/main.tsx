import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { MotionProvider } from "./motion";
import { SkinProvider } from "./skin";
import "./styles.css";

// Лаунчер — это приложение, а не веб-страница: контекстное меню ПКМ
// (с пунктами «Назад», «Перезагрузить», «Сохранить как…») здесь лишнее
// и ломает ощущение нативности. Глушим его полностью.
window.addEventListener("contextmenu", (e) => e.preventDefault());

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <MotionProvider>
      <SkinProvider>
        <App />
      </SkinProvider>
    </MotionProvider>
  </React.StrictMode>,
);
