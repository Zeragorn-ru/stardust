import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import DebugAnimations from "./components/DebugAnimations";
import { MotionProvider } from "./motion";
import { SkinProvider } from "./skin";
import { applyAppearance, storedAppearance } from "./accent";
import "./styles.css";

// Тема и акцент применяются до первого рендера — иначе стартовый кадр
// мелькает дефолтными цветами.
applyAppearance(storedAppearance());

// Лаунчер — это приложение, а не веб-страница: контекстное меню ПКМ
// (с пунктами «Назад», «Перезагрузить», «Сохранить как…») здесь лишнее
// и ломает ощущение нативности. Глушим его полностью.
window.addEventListener("contextmenu", (e) => e.preventDefault());

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <MotionProvider>
      <SkinProvider>
        {window.location.hash === "#debug" ? <DebugAnimations /> : <App />}
      </SkinProvider>
    </MotionProvider>
  </React.StrictMode>,
);
