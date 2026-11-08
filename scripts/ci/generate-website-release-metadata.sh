#!/usr/bin/env bash
set -euo pipefail

# Generate a small, immutable-at-build-time snapshot for the public website.
# The stable alias remains the source of truth; the release API is checked
# against the version from latest.json before any installer URL is published.
output=${1:-website/public/release-metadata.json}
repo=${GITHUB_REPOSITORY:-Zeragorn-ru/stardust}
api="https://api.github.com/repos/${repo}"
tmp_dir=$(mktemp -d)
trap 'rm -rf "$tmp_dir"' EXIT

alias="$tmp_dir/alias.json"
meta="$tmp_dir/latest.json"
release="$tmp_dir/release.json"

gh api "$api/releases/tags/launcher-stable" >"$alias"
asset_url=$(jq -r '.assets[]? | select(.name == "latest.json") | .url' "$alias" | head -n1)
if [[ -z "$asset_url" || "$asset_url" == "null" ]]; then
  echo 'launcher-stable does not contain latest.json' >&2
  exit 1
fi
gh api -H 'Accept: application/octet-stream' "$asset_url" >"$meta"
version=$(jq -r '.version // empty' "$meta" | sed 's/^v//')
if [[ ! "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "Invalid stable launcher version: ${version:-<empty>}" >&2
  exit 1
fi

gh api "$api/releases/tags/v$version" >"$release"
tag=$(jq -r '.tag_name // empty' "$release")
draft=$(jq -r '.draft // true' "$release")
if [[ "$tag" != "v$version" || "$draft" != "false" ]]; then
  echo "Stable metadata points to invalid release: tag=$tag draft=$draft" >&2
  exit 1
fi

release_url=$(jq -r '.html_url' "$release")
windows=$(jq -r '[.assets[]? | select(.name | test("\\.(exe|msi)$"; "i")) | select(.name | test("bootstrap|sha256"; "i") | not) | .browser_download_url][0] // ""' "$release")
macos=$(jq -r '[.assets[]? | select(.name | test("\\.dmg$"; "i")) | select(.name | test("bootstrap|sha256"; "i") | not) | .browser_download_url][0] // ""' "$release")
linux=$(jq -r '[.assets[]? | select(.name | test("\\.(AppImage|deb|rpm)$"; "i")) | select(.name | test("bootstrap|sha256"; "i") | not) | .browser_download_url][0] // ""' "$release")

mkdir -p "$(dirname "$output")"
jq -n \
  --arg version "$version" \
  --arg tag "$tag" \
  --arg releaseUrl "$release_url" \
  --arg windows "$windows" \
  --arg macos "$macos" \
  --arg linux "$linux" \
  '{version: $version, tag: $tag, releaseUrl: $releaseUrl, assets: {windows: $windows, macos: $macos, linux: $linux}}' \
  >"$output"
printf 'Generated %s for %s\n' "$output" "$tag"
