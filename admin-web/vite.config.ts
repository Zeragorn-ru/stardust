import { defineConfig } from "vite";
import { resolve } from "node:path";
import react from "@vitejs/plugin-react";

// Dev-сервер админки. В разработке проксируем API на локальный admin-server,
// чтобы не упираться в CORS и обращаться по относительным путям (`/api/...`).
//
// Сборка многостраничная: десктопный интерфейс — в корне (`index.html`),
// мобильный — под `/m/` (`m/index.html`). У каждого свой entry, но общий код
// (api, типы, FileManager и пр.) попадает в общие чанки автоматически.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 1430,
    strictPort: true,
    proxy: {
      "/api": "http://127.0.0.1:8081",
      "/manifest": "http://127.0.0.1:8081",
      "/files": "http://127.0.0.1:8081",
      "/authlib-injector.jar": "http://127.0.0.1:8081",
    },
  },
  build: {
    target: "es2021",
    minify: "esbuild",
    sourcemap: false,
    rollupOptions: {
      input: {
        main: resolve(__dirname, "index.html"),
        mobile: resolve(__dirname, "m/index.html"),
      },
    },
  },
});
