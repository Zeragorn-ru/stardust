import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Tauri ожидает фиксированный порт и не очищает экран,
// чтобы не затирать сообщения Rust-бэка.
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
  },
  // Сборка под возможности webview Tauri.
  build: {
    target: "es2021",
    minify: "esbuild",
    sourcemap: false,
  },
});
