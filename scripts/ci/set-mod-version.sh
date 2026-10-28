#!/usr/bin/env bash
# Подставляет версию мода в build.gradle обеих версий мода:
# stardust-mod (NeoForge) и stardust-mod-fabric (Fabric).
# Аргумент: версия без префикса mod-v (например 0.3.5).
set -euo pipefail

version="${1:?usage: set-mod-version.sh <version>}"
root="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$root"

echo "Setting mod version to $version"

for gradle_file in stardust-mod/build.gradle stardust-mod-fabric/build.gradle; do
  # Без флага /g: первое вхождение version = 'X.Y.Z' — версия проекта,
  # остальные (например neoForge.version) не должны перезаписываться.
  perl -0pi -e "s/(version\s*=\s*')[0-9]+\.[0-9]+\.[0-9]+(')/\${1}$version\${2}/" "$gradle_file"

  if ! grep -q "version = '$version'" "$gradle_file"; then
    echo "ERROR: version replacement failed in $gradle_file" >&2
    exit 1
  fi
done
