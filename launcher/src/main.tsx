import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { MotionProvider } from "./motion";
import { SkinProvider } from "./skin";
import "./styles.css";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <MotionProvider>
      <SkinProvider>
        <App />
      </SkinProvider>
    </MotionProvider>
  </React.StrictMode>,
);
