#!/usr/bin/env bash
# Обновление бекенда на сервере.
# Используется CI (SSH) или вручную: bash update.sh
set -euo pipefail

# Compose-файл и каталоги data/, logs/ лежат прямо в /opt/stardust,
# а volume-пути в compose относительные — поэтому работаем оттуда.
cd /opt/stardust

# Фиксируем имя compose-проекта, чтобы оно не зависело от имени каталога.
# Иначе контейнеры с жёстким container_name (launcher-*) могут оказаться
# "чужими" для проекта и ломать up конфликтом имён.
export COMPOSE_PROJECT_NAME=stardust

echo "==> Pulling Docker images..."
docker compose pull

# Останавливаем и удаляем контейнеры текущего проекта вместе с orphan'ами,
# чтобы пересоздать стек начисто и не словить конфликт имён.
echo "==> Stopping existing containers..."
docker compose down --remove-orphans

# Подстраховка: если контейнеры с фиксированными именами остались от старого
# проекта (другое имя каталога/проекта) — down их не тронет. Сносим по именам.
echo "==> Removing leftover containers by fixed name (if any)..."
for name in launcher-auth-db launcher-auth-server launcher-admin-server \
            launcher-telegram-bot launcher-squid launcher-admin-web; do
  if [ -n "$(docker ps -aq -f "name=^/${name}$")" ]; then
    docker rm -f "$name" >/dev/null 2>&1 || true
  fi
done

echo "==> Recreating containers..."
docker compose up -d --remove-orphans

echo "==> Cleaning up old images..."
docker image prune -f

echo "==> Done. Containers:"
docker compose ps
