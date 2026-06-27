#!/usr/bin/env bash
# Обновление бекенда на сервере.
# Используется CI (SSH) или вручную: curl -sSL https://raw.githubusercontent.com/.../update.sh | bash
set -euo pipefail

REPO_DIR="/opt/stardust"
DEPLOY_DIR="$REPO_DIR/deploy"

echo "==> Pulling latest changes..."
cd "$REPO_DIR"
git pull --ff-only

echo "==> Pulling Docker images..."
cd "$DEPLOY_DIR"
docker compose pull

echo "==> Recreating containers..."
docker compose up -d --remove-orphans

echo "==> Cleaning up old images..."
docker image prune -f

echo "==> Done. Containers:"
docker compose ps
