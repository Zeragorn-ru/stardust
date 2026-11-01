#!/usr/bin/env bash
# Установка StarDust authlib-injector для Minecraft-сервера.
#
# Скачивает последнюю стабильную патченую сборку (алиас authlib-injector-stable)
# с проверкой SHA-256 и кладёт jar в указанное место — для запуска сервера с
# `-javaagent:<путь>/authlib-injector.jar=https://auth.example.com`.
#
# Использование:
#   scripts/fetch-authlib-injector.sh [целевой-каталог]     # по умолчанию текущий
#   scripts/fetch-authlib-injector.sh /opt/mc/server        # конкретный каталог
#
# Обновление лаунчерных клиентов отдельным шагом не нужно: лаунчер сам видит
# новую версию через admin-server (`/authlib-injector/latest.json`) и перекачивает
# jar при следующем запуске игры.
set -euo pipefail

readonly RELEASE_BASE="https://github.com/Zeragorn-ru/stardust/releases/download/authlib-injector-stable"
readonly TARGET_DIR="${1:-.}"
readonly JAR_PATH="$TARGET_DIR/authlib-injector.jar"

mkdir -p "$TARGET_DIR"

tmp_jar=$(mktemp)
tmp_sum=$(mktemp)
trap 'rm -f "$tmp_jar" "$tmp_sum"' EXIT

echo "Скачиваем StarDust authlib-injector (stable)…"
curl -fsSL "$RELEASE_BASE/authlib-injector.jar" -o "$tmp_jar"
curl -fsSL "$RELEASE_BASE/authlib-injector.json" -o "$tmp_sum" || true

# Проверка контрольной суммы, если метаданные доступны.
expected=$(python3 -c 'import json,sys; print(json.load(sys.stdin).get("sha256",""))' < "$tmp_sum" 2>/dev/null || echo "")
if [ -n "$expected" ]; then
  actual=$(shasum -a 256 "$tmp_jar" | cut -d' ' -f1)
  if [ "$actual" != "$expected" ]; then
    echo "ОШИБКА: sha256 не совпадает (ожидали $expected, получили $actual)" >&2
    exit 1
  fi
  echo "Контрольная сумма совпадает: $actual"
else
  echo "Предупреждение: метаданные не получены, проверка sha256 пропущена" >&2
fi

mv "$tmp_jar" "$JAR_PATH"
echo "Установлено: $JAR_PATH"

version=$(python3 -c 'import json,sys; print(json.load(sys.stdin).get("version","unknown"))' < "$tmp_sum" 2>/dev/null || echo "unknown")
echo "Версия: $version"
echo
echo "Запуск Minecraft-сервера:"
echo "  -javaagent:$JAR_PATH=<URL-нашего-auth-сервера>"
