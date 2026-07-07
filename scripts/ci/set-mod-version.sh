#!/usr/bin/env bash
# Подставляет версию мода в stardust-mod/build.gradle.
# Аргумент: версия без префикса mod-v (например 0.3.5).
set -euo pipefail

version="${1:?usage: set-mod-version.sh <version>}"
root="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$root"

echo "Setting mod version to $version"

perl -0pi -e "s/(version\s*=\s*')[0-9]+\.[0-9]+\.[0-9]+(')/\${1}$version\${2}/" stardust-mod/build.gradle

if ! grep -q "$version" stardust-mod/build.gradle; then
  echo "ERROR: version replacement failed in stardust-mod/build.gradle" >&2
  exit 1
fi
