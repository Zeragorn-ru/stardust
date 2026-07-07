# Сбор установщиков лаунчера в dist/launcher-bundles/.
#
# Tauri кладёт артефакты в разные каталоги в зависимости от target/profile:
#   Windows  → target/.../bundle/nsis/*.exe
#   Linux    → target/.../bundle/{deb,rpm,appimage}/
#   macOS    → target/.../bundle/dmg/*.dmg  (НЕ bundle/macos — там только .app)
#   universal macOS → target/universal-apple-darwin/release/bundle/dmg/
set -euo pipefail

root="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$root"

out="dist/launcher-bundles"
rm -rf "$out"
mkdir -p "$out"

search_dirs=(
  "target/launcher-release/bundle/nsis"
  "target/launcher-release/bundle/dmg"
  "target/launcher-release/bundle/macos"
  "target/launcher-release/bundle/deb"
  "target/launcher-release/bundle/rpm"
  "target/launcher-release/bundle/appimage"
  "target/universal-apple-darwin/release/bundle/dmg"
  "target/universal-apple-darwin/release/bundle/macos"
  "target/release/bundle/nsis"
  "target/release/bundle/dmg"
  "target/release/bundle/macos"
  "target/release/bundle/deb"
  "target/release/bundle/rpm"
  "target/release/bundle/appimage"
)

found=0
for dir in "${search_dirs[@]}"; do
  [ -d "$dir" ] || continue
  echo "==> scanning $dir"
  while IFS= read -r -d '' file; do
    cp -v "$file" "$out/"
    found=$((found + 1))
  done < <(find "$dir" -maxdepth 1 -type f \( \
    -name '*.exe' -o -name '*.dmg' -o -name '*.deb' -o -name '*.rpm' -o -name '*.AppImage' -o -name '*.msi' \
  \) -print0)
done

if [ -f launcher/src-tauri/nsis/bootstrap.exe ]; then
  cp -v launcher/src-tauri/nsis/bootstrap.exe "$out/"
  found=$((found + 1))
fi

if [ "$found" -eq 0 ]; then
  echo "WARNING: no launcher bundles found" >&2
  echo "Searched:" >&2
  for dir in "${search_dirs[@]}"; do
    echo "  - $dir" >&2
  done
  echo "==> DEBUG: any bundle dirs under target/" >&2
  find target -type d -name bundle 2>/dev/null | head -30 >&2 || true
  exit 1
fi

echo "==> checksums"
for artifact in "$out"/*; do
  [ -f "$artifact" ] || continue
  case "$(basename "$artifact")" in
    *.sha256) continue ;;
  esac
  sha256sum "$artifact" | awk '{print $1}' > "${artifact}.sha256"
done

echo "==> collected $found file(s) in $out/"
ls -la "$out/"
