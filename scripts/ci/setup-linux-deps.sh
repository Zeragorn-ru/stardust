#!/usr/bin/env bash
# Системные зависимости для сборки Tauri-лаунчера на Debian/Ubuntu.
# CI: ubuntu-22.04 (webkit2gtk 4.1 стабилен; на 24.04 у Tauri бывает пустое окно).
set -euo pipefail

sudo apt-get update
sudo apt-get install -y \
  libwebkit2gtk-4.1-dev \
  libappindicator3-dev \
  librsvg2-dev \
  patchelf \
  libgtk-3-dev
