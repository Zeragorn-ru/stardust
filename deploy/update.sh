#!/usr/bin/env bash
# Обновление бекенда на сервере.
# Используется CI (SSH) или вручную: bash update.sh
set -euo pipefail

cd "$(dirname "$0")"

echo "==> Pulling Docker images..."
docker compose pull

echo "==> Recreating containers..."
docker compose up -d --remove-orphans

echo "==> Cleaning up old images..."
docker image prune -f

echo "==> Done. Containers:"
docker compose ps
