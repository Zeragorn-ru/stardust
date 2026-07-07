# Сбор установщиков лаунчера в dist/launcher-bundles/.
#
# Рекурсивный поиск по target/**/bundle/** — покрывает все профили и triple
# (в т.ч. universal-apple-darwin/launcher-release/bundle/dmg).
set -euo pipefail

root="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$root"

out="dist/launcher-bundles"
rm -rf "$out"
mkdir -p "$out"

found=0
while IFS= read -r -d '' file; do
  cp -v "$file" "$out/"
  found=$((found + 1))
done < <(find target -path '*/bundle/*' -type f \( \
  -name '*.exe' -o -name '*.dmg' -o -name '*.deb' -o -name '*.rpm' -o -name '*.AppImage' -o -name '*.msi' \
\) -print0)

if [ -f launcher/src-tauri/nsis/bootstrap.exe ]; then
  cp -v launcher/src-tauri/nsis/bootstrap.exe "$out/"
  found=$((found + 1))
fi

if [ "$found" -eq 0 ]; then
  echo "WARNING: no launcher bundles found" >&2
  echo "==> DEBUG: bundle tree under target/" >&2
  find target -path '*/bundle/*' -print 2>/dev/null | head -50 >&2 || true
  exit 1
fi

echo "==> checksums"
for artifact in "$out"/*; do
  [ -f "$artifact" ] || continue
  case "$(basename "$artifact")" in
    *.sha256) continue ;;
  esac
  bash "$root/scripts/ci/sha256-file.sh" "$artifact" > "${artifact}.sha256"
done

echo "==> collected $found file(s) in $out/"
ls -la "$out/"
