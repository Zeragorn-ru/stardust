import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Dev-сервер админки. В разработке проксируем API на локальный admin-server,
// чтобы не упираться в CORS и обращаться по относительным путям (`/api/...`).
export default defineConfig({
  plugins: [react()],
  server: {
    port: 1430,
    strictPort: true,
    proxy: {
      "/api": "http://127.0.0.1:8081",
      "/manifest": "http://127.0.0.1:8081",
      "/files": "http://127.0.0.1:8081",
    },
  },
  build: {
    target: "es2021",
    minify: "esbuild",
    sourcemap: false,
  },
});
