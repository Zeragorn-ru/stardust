#!/bin/sh
# Релиз лаунчера через тег.
#
# Версия в исходниках — плейсхолдер 0.0.0. Источник правды — git-тег вида
# vX.Y.Z. На пуш тега workflow (.github/workflows/launcher-release.yml) сам
# подставляет версию в файлы и собирает установщики.
#
# Этот скрипт ничего в файлах не меняет: он берёт последний тег, считает
# следующий и пушит новый тег.
#
# Использование:
#   sh scripts/release.sh            # патч-бамп: v0.2.9 -> v0.2.10
#   sh scripts/release.sh fix        # fix-релиз: v0.2.9 -> v0.2.9-fix1, v0.2.9-fix1 -> v0.2.9-fix2
#   sh scripts/release.sh minor      # v0.2.9 -> v0.3.0
#   sh scripts/release.sh major      # v0.2.9 -> v1.0.0
#   sh scripts/release.sh 0.3.0      # явная версия -> тег v0.3.0
#   sh scripts/release.sh 0.3.0-fix1 # явный fix-релиз -> тег v0.3.0-fix1
#
# Флаги:
#   --no-push   создать тег локально, без пуша
#   --dry-run   показать вычисленный тег, ничего не делая
set -eu

ROOT=$(cd "$(dirname "$0")/.." && pwd)
cd "$ROOT"

PUSH=1
DRY_RUN=0
BUMP=""

for arg in "$@"; do
  case "$arg" in
    --no-push) PUSH=0 ;;
    --dry-run) DRY_RUN=1 ;;
    -*) echo "Неизвестный флаг: $arg" >&2; exit 2 ;;
    *) BUMP="$arg" ;;
  esac
done

# --- последний релизный тег (обычный и fix-релиз) ---
LAST=$(git tag --list 'v[0-9]*.[0-9]*.[0-9]*' 'v[0-9]*.[0-9]*.[0-9]*-fix[0-9]*' --sort=-version:refname | head -n1)
if [ -z "$LAST" ]; then
  CURRENT="0.0.0"
  echo "Релизных тегов пока нет, отсчёт от 0.0.0."
else
  CURRENT="${LAST#v}"
  echo "Последний тег: $LAST"
fi

# Fix-суффикс текущего тега не участвует в разборе X.Y.Z.
BASE=$(echo "$CURRENT" | sed 's/-fix[0-9]*$//')
FIX=$(echo "$CURRENT" | sed -n 's/^[0-9]*\.[0-9]*\.[0-9]*-fix\([0-9]*\)$/\1/p')

MAJOR=$(echo "$BASE" | cut -d. -f1)
MINOR=$(echo "$BASE" | cut -d. -f2)
PATCH=$(echo "$BASE" | cut -d. -f3)

case "${BUMP:-patch}" in
  fix)
    # Следующий fix-релиз поверх той же базовой версии: v0.11.19-fix1 -> v0.11.19-fix2.
    NEW="$MAJOR.$MINOR.$PATCH-fix$(( ${FIX:-0} + 1 ))"
    ;;
  patch|"") NEW="$MAJOR.$MINOR.$((PATCH + 1))" ;;
  minor)    NEW="$MAJOR.$((MINOR + 1)).0" ;;
  major)    NEW="$((MAJOR + 1)).0.0" ;;
  [0-9]*.[0-9]*.[0-9]*-fix[0-9]*) NEW="$BUMP" ;;
  [0-9]*.[0-9]*.[0-9]*) NEW="$BUMP" ;;
  *) echo "Некорректный аргумент версии: $BUMP" >&2; exit 2 ;;
esac

TAG="v$NEW"
echo "Новый тег: $TAG"

if git rev-parse -q --verify "refs/tags/$TAG" >/dev/null 2>&1; then
  echo "Тег $TAG уже существует." >&2
  exit 1
fi

if [ "$DRY_RUN" -eq 1 ]; then
  echo "[dry-run] git tag $TAG"
  [ "$PUSH" -eq 1 ] && echo "[dry-run] git push origin $TAG"
  exit 0
fi

git tag "$TAG"
echo "Создан тег $TAG."

if [ "$PUSH" -eq 1 ]; then
  git push origin "$TAG"
  echo "Запушено. Релизная сборка стартует по тегу $TAG."
else
  echo "Пуш пропущен (--no-push). Когда будешь готов:"
  echo "  git push origin $TAG"
fi
