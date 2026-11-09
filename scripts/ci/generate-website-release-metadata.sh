#!/usr/bin/env bash
set -euo pipefail

# Generate a small, immutable-at-build-time snapshot for the public website.
# The stable alias remains the source of truth; the release API is checked
# against the version from latest.json before any installer URL is published.
output=${1:-website/public/release-metadata.json}
repo=${GITHUB_REPOSITORY:-Zeragorn-ru/stardust}
api="https://api.github.com/repos/${repo}"
# GitHub может недолго отдавать закэшированный снимок alias/release сразу после
# продвижения версии в stable. Повторяем только чтение и всегда сохраняем строгую
# проверку: draft и prerelease никогда не принимаются.
api_retries=${RELEASE_METADATA_API_RETRIES:-5}
api_retry_delay=${RELEASE_METADATA_API_RETRY_DELAY:-3}
tmp_dir=$(mktemp -d)
trap 'rm -rf "$tmp_dir"' EXIT

alias="$tmp_dir/alias.json"
meta="$tmp_dir/latest.json"
release="$tmp_dir/release.json"

api_json() {
  local url=$1
  local output_file=$2
  local accept=${3:-application/vnd.github+json}
  local attempt separator='?'
  [[ "$url" == *\?* ]] && separator='&'
  for ((attempt = 1; attempt <= api_retries; attempt++)); do
    if gh api \
      -H "Accept: $accept" \
      -H 'Cache-Control: no-cache' \
      -H 'Pragma: no-cache' \
      "${url}${separator}_stardust_attempt=${attempt}" >"$output_file"; then
      return 0
    fi
    if (( attempt < api_retries )); then
      echo "GitHub API read failed (attempt $attempt/$api_retries); retrying in ${api_retry_delay}s..." >&2
      sleep "$api_retry_delay"
    fi
  done
  return 1
}

api_json "$api/releases/tags/launcher-stable" "$alias" || {
  echo 'Не удалось прочитать launcher-stable из GitHub API' >&2
  exit 1
}
asset_url=$(jq -r '.assets[]? | select(.name == "latest.json") | .url' "$alias" | head -n1)
if [[ -z "$asset_url" || "$asset_url" == "null" ]]; then
  echo 'launcher-stable does not contain latest.json' >&2
  exit 1
fi
api_json "$asset_url" "$meta" application/octet-stream || {
  echo 'Не удалось скачать latest.json из launcher-stable' >&2
  exit 1
}
version=$(jq -r '.version // empty' "$meta" | sed 's/^v//')
if [[ ! "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "Invalid stable launcher version: ${version:-<empty>}" >&2
  exit 1
fi

release_url_api="$api/releases/tags/v$version"
validated=false
for ((attempt = 1; attempt <= api_retries; attempt++)); do
  if ! api_json "$release_url_api" "$release"; then
    echo "Не удалось прочитать релиз v$version из GitHub API" >&2
    exit 1
  fi
  tag=$(jq -r '.tag_name // empty' "$release")
  draft=$(jq -r 'if .draft == false then "false" else "true" end' "$release")
  prerelease=$(jq -r 'if .prerelease == false then "false" else "true" end' "$release")
  if [[ "$tag" == "v$version" && "$draft" == "false" && "$prerelease" == "false" ]]; then
    validated=true
    break
  fi
  if (( attempt < api_retries )); then
    echo "Stable release snapshot is not ready (attempt $attempt/$api_retries); retrying in ${api_retry_delay}s..." >&2
    sleep "$api_retry_delay"
  fi
done
if [[ "$validated" != true ]]; then
  echo "Stable metadata points to invalid release: tag=$tag draft=$draft prerelease=$prerelease" >&2
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
