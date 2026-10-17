#!/usr/bin/env bash
# Подставляет версию лаунчера в package.json, tauri.conf.json, Cargo.toml и Cargo.lock.
# Используется в CI перед релизной сборкой. Аргумент: версия без префикса v
# (например 0.7.22 или 0.7.22-fix1).
#
# Fix-суффикс из тега vX.Y.Z-fixN переводится в числовой pre-release:
# 0.11.19-fix1 -> 0.11.19-1. Такой вид валиден одновременно для строгого
# semver (tauri.conf.json/Cargo/npm — буквенный идентификатор отвергается
# конфигом Tauri и WiX MSI) и для WiX ProductVersion (цифровой
# идентификатор, не длиннее 65535). Клиентский компаратор лаунчера
# (is_newer) трактует -N как номер фикса: 0.11.19-1 > 0.11.19.
set -euo pipefail

version="${1:?usage: set-launcher-version.sh <version>}"
version="${version#v}"
root="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$root"

if [[ "$version" =~ ^([0-9]+)\.([0-9]+)\.([0-9]+)-fix([0-9]+)$ ]]; then
  version="${BASH_REMATCH[1]}.${BASH_REMATCH[2]}.${BASH_REMATCH[3]}-${BASH_REMATCH[4]}"
elif ! [[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9]+)?$ ]]; then
  echo "ERROR: некорректная версия: $version (ожидаются X.Y.Z или X.Y.Z-fixN)" >&2
  exit 1
fi

echo "Setting launcher version to $version"

# Паттерны покрывают и чистый X.Y.Z, и X.Y.Z-N (прошлый fix-релиз),
# чтобы fix2 мог лечь поверх fix1.
perl -0pi -e "s/(\"version\"\s*:\s*\")[0-9]+\.[0-9]+\.[0-9]+(-[0-9]+)?(\")/\${1}$version\${3}/" launcher/package.json
perl -0pi -e "s/(\"version\"\s*:\s*\")[0-9]+\.[0-9]+\.[0-9]+(-[0-9]+)?(\")/\${1}$version\${3}/" launcher/src-tauri/tauri.conf.json
perl -0pi -e "s/^(version\s*=\s*\")[0-9]+\.[0-9]+\.[0-9]+(-[0-9]+)?(\")/\${1}$version\${3}/m" launcher/src-tauri/Cargo.toml
perl -0pi -e "s/(name = \"launcher\"\nversion = \")[0-9]+\.[0-9]+\.[0-9]+(-[0-9]+)?(\")/\${1}$version\${3}/" Cargo.lock

if ! grep -q "\"$version\"" launcher/package.json; then
  echo "ERROR: version replacement failed in launcher/package.json" >&2
  exit 1
fi
