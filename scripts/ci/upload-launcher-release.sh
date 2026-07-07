#!/usr/bin/env bash
# Создаёт GitHub Release (если нет) и загружает установщики + checksums.
# Требует GH_TOKEN. Аргумент: тег (например v0.7.22).
set -euo pipefail

tag="${1:?usage: upload-launcher-release.sh <tag>}"
root="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$root"

title="Launcher $tag"

if ! gh release view "$tag" >/dev/null 2>&1; then
  gh release create "$tag" --title "$title" --generate-notes
  echo "Created release $tag"
else
  echo "Release $tag already exists"
fi

"$root/scripts/ci/collect-launcher-bundles.sh"

for artifact in dist/launcher-bundles/*; do
  [ -f "$artifact" ] || continue
  base="$(basename "$artifact")"
  case "$base" in
    *.sha256) continue ;;
  esac
  echo "Uploading $base"
  gh release upload "$tag" "$artifact" "${artifact}.sha256" --clobber
done
