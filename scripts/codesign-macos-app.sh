#!/usr/bin/env bash
# Ad-hoc подпись StarDust.app с entitlements для локальной разработки.
# Без подписи macOS не встраивает entitlements, и Simple Voice Chat видит
# «лаунчер не поддерживает микрофон» (NOT_DETERMINED).
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
profile="${LAUNCHER_PROFILE:-launcher-release}"
entitlements="$root/launcher/src-tauri/Entitlements.plist"

app=""
while IFS= read -r candidate; do
  app="$candidate"
done < <(find "$root/target" -path "*/${profile}/bundle/macos/StarDust.app" -type d 2>/dev/null | head -1)

if [ -z "$app" ]; then
  while IFS= read -r candidate; do
    app="$candidate"
  done < <(find "$root/target" -path '*/bundle/macos/StarDust.app' -type d 2>/dev/null | head -1)
fi

if [ -z "$app" ]; then
  echo "StarDust.app not found under target/ (profile=${profile})" >&2
  exit 1
fi

if [ ! -f "$entitlements" ]; then
  echo "Entitlements not found: $entitlements" >&2
  exit 1
fi

exec_bin="$app/Contents/MacOS/launcher"
if [ ! -f "$exec_bin" ]; then
  echo "Executable not found: $exec_bin" >&2
  exit 1
fi

echo "==> Ad-hoc signing $app"
codesign --force --sign - --entitlements "$entitlements" --timestamp=none "$exec_bin"
codesign --force --sign - --entitlements "$entitlements" --timestamp=none "$app"

echo "==> Embedded entitlements:"
codesign -d --entitlements :- "$app" 2>&1 | rg "audio-input|camera" || true
