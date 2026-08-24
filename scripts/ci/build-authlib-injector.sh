#!/usr/bin/env bash
set -euo pipefail

# Usage: build-authlib-injector.sh [output.jar] [version]
# Keep the upstream source pinned. Update only with a Paper 1.21.1 integration test.
readonly UPSTREAM_REPO="https://github.com/yushijinhun/authlib-injector.git"
readonly UPSTREAM_COMMIT="fc19f0df17d6860c7028dc393eff3550f7489e14"
readonly ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
readonly OUTPUT="${1:-$ROOT/authlib-injector.jar}"
readonly VERSION="${2:-0.1.0}"
readonly WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

mkdir -p "$(dirname "$OUTPUT")"
git clone --filter=blob:none "$UPSTREAM_REPO" "$WORK/src"
git -C "$WORK/src" checkout --detach "$UPSTREAM_COMMIT"
python3 "$ROOT/scripts/ci/patch-authlib-injector.py" "$WORK/src"

(
  cd "$WORK/src"
  AI_VERSION_NUMBER="stardust-${VERSION}" ./gradlew --no-daemon test shadowJar
)

shopt -s nullglob
jars=("$WORK"/src/build/libs/authlib-injector-*.jar)
filtered=()
for candidate in "${jars[@]}"; do
  [[ "$candidate" == *-sources.jar ]] || filtered+=("$candidate")
done
test "${#filtered[@]}" -gt 0
cp "${filtered[0]}" "$OUTPUT"
sha256sum "$OUTPUT"
