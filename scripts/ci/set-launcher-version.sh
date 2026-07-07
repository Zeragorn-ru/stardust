#!/usr/bin/env bash
# Подставляет версию лаунчера в package.json, tauri.conf.json, Cargo.toml и Cargo.lock.
# Используется в CI перед релизной сборкой. Аргумент: версия без префикса v (например 0.7.22).
set -euo pipefail

version="${1:?usage: set-launcher-version.sh <version>}"
version="${version#v}"
root="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$root"

echo "Setting launcher version to $version"

perl -0pi -e "s/(\"version\"\s*:\s*\")[0-9]+\.[0-9]+\.[0-9]+(\")/\${1}$version\${2}/" launcher/package.json
perl -0pi -e "s/(\"version\"\s*:\s*\")[0-9]+\.[0-9]+\.[0-9]+(\")/\${1}$version\${2}/" launcher/src-tauri/tauri.conf.json
perl -0pi -e "s/^(version\s*=\s*\")[0-9]+\.[0-9]+\.[0-9]+(\")/\${1}$version\${2}/m" launcher/src-tauri/Cargo.toml
perl -0pi -e "s/(name = \"launcher\"\nversion = \")[0-9]+\.[0-9]+\.[0-9]+(\")/\${1}$version\${2}/" Cargo.lock

if ! grep -q "$version" launcher/package.json; then
  echo "ERROR: version replacement failed in launcher/package.json" >&2
  exit 1
fi
