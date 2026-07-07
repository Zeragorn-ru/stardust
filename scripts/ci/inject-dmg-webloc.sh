#!/usr/bin/env bash
# Вкладывает Установка.webloc в собранный .dmg (только macOS CI).
# Tauri не умеет класть произвольные файлы в DMG — делаем post-build:
# mount → ditto → добавить webloc → hdiutil create.
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

dmg=""
while IFS= read -r f; do
  dmg="$f"
done < <(find target -path '*/bundle/dmg/*.dmg' -type f 2>/dev/null | head -1)

if [ -z "$dmg" ]; then
  echo "::warning::No .dmg under target/**/bundle/dmg/ — skip webloc injection"
  exit 0
fi

echo "==> Injecting webloc into: $dmg"

work=$(mktemp -d)
mount_point="$work/mnt"
staging="$work/staging"
mkdir -p "$mount_point" "$staging"

cleanup() {
  if mount | grep -q "$mount_point"; then
    hdiutil detach "$mount_point" -quiet 2>/dev/null || hdiutil detach "$mount_point" -force
  fi
  rm -rf "$work"
}
trap cleanup EXIT

hdiutil attach "$dmg" -nobrowse -readonly -mountpoint "$mount_point"
volname=$(diskutil info "$mount_point" | awk -F': ' '/Volume Name/ {print $2; exit}')
ditto "$mount_point/" "$staging/"
hdiutil detach "$mount_point" -quiet

cp "$webloc" "$staging/Установка.webloc"

# Имя тома для DMG — как у продукта, если не прочитали с диска.
volname="${volname:-StarDust}"
out="${dmg}.injected"
rm -f "$out"

hdiutil create -volname "$volname" -srcfolder "$staging" -ov -format UDZO "$out"
mv "$out" "$dmg"

echo "==> Injected Установка.webloc (volume: $volname)"
