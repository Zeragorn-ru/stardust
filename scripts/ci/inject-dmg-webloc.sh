#!/usr/bin/env bash
# Вкладывает Установка.webloc в собранный .dmg (только macOS CI).
# Важно: пересборка DMG сбрасывает подпись/нотаризацию. Если заданы APPLE_*,
# после inject повторно отправляем DMG в notarytool (когда есть credentials).
set -euo pipefail

if [ "$(uname -s)" != "Darwin" ]; then
  echo "Not macOS — skip DMG webloc injection"
  exit 0
fi

root="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$root"

webloc="launcher/src-tauri/dmg/Установка.webloc"
if [ ! -f "$webloc" ]; then
  echo "::warning::Webloc not found: $webloc — skip"
  exit 0
fi

# Самый свежий DMG (не head -1 от find — порядок не гарантирован).
dmg=""
while IFS= read -r f; do
  dmg="$f"
done < <(find target -path '*/bundle/dmg/*.dmg' -type f -print0 2>/dev/null | xargs -0 ls -t 2>/dev/null | head -1)

if [ -z "$dmg" ] || [ ! -f "$dmg" ]; then
  echo "::warning::No .dmg under target/**/bundle/dmg/ — skip webloc injection"
  exit 0
fi

echo "==> Injecting webloc into: $dmg"

work=$(mktemp -d)
mount_point="$work/mnt"
staging="$work/staging"
mkdir -p "$mount_point" "$staging"

mounted=0
cleanup() {
  if [ "$mounted" -eq 1 ]; then
    hdiutil detach "$mount_point" -quiet 2>/dev/null || hdiutil detach "$mount_point" -force || true
    mounted=0
  fi
  rm -rf "$work"
}
trap cleanup EXIT

hdiutil attach "$dmg" -nobrowse -readonly -mountpoint "$mount_point"
mounted=1
volname=$(diskutil info "$mount_point" | awk -F': ' '/Volume Name/ {print $2; exit}')
ditto "$mount_point/" "$staging/"
hdiutil detach "$mount_point" -quiet
mounted=0

cp "$webloc" "$staging/Установка.webloc"

volname="${volname:-StarDust}"
out="${dmg}.injected"
rm -f "$out"

hdiutil create -volname "$volname" -srcfolder "$staging" -ov -format UDZO "$out"
mv "$out" "$dmg"

echo "==> Injected Установка.webloc (volume: $volname)"

# Пересобранный DMG нужно снова нотаризовать, иначе Gatekeeper отклонит подписанный релиз.
if [ -n "${APPLE_API_KEY:-}" ] && [ -n "${APPLE_API_ISSUER:-}" ] && [ -n "${APPLE_API_KEY_PATH:-}" ]; then
  echo "==> Re-notarizing DMG via App Store Connect API"
  xcrun notarytool submit "$dmg" --key "$APPLE_API_KEY_PATH" --key-id "$APPLE_API_KEY" --issuer "$APPLE_API_ISSUER" --wait
  xcrun stapler staple "$dmg"
elif [ -n "${APPLE_ID:-}" ] && [ -n "${APPLE_PASSWORD:-}" ] && [ -n "${APPLE_TEAM_ID:-}" ]; then
  echo "==> Re-notarizing DMG via Apple ID"
  xcrun notarytool submit "$dmg" --apple-id "$APPLE_ID" --password "$APPLE_PASSWORD" --team-id "$APPLE_TEAM_ID" --wait
  xcrun stapler staple "$dmg"
elif [ -n "${APPLE_CERTIFICATE:-}" ]; then
  echo "::warning::DMG re-built after notarization; set APPLE_API_* or APPLE_ID/PASSWORD/TEAM_ID to re-notarize"
fi
