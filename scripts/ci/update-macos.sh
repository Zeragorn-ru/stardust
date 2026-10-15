#!/usr/bin/env bash
# macOS auto-update helper: replaces .app bundle while launcher is exiting.
#
# Called by the launcher (update.rs) after downloading + extracting the new .app.
# Arguments:
#   $1 = path to new .app directory (extracted from .app.zip)
#   $2 = path to current .app directory (being replaced)
#   $3 = app binary name (e.g. "StarDust")
set -euo pipefail

new_app="$1"
target_app="$2"
app_name="${3:-StarDust}"

# Wait for the running launcher to fully exit.
pid_file="${target_app}/Contents/MacOS/.update-pid"
if [ -f "$pid_file" ]; then
  old_pid=$(cat "$pid_file")
  echo "[update-macos] waiting for launcher PID $old_pid to exit…"
  for i in $(seq 1 60); do
    if ! kill -0 "$old_pid" 2>/dev/null; then
      echo "[update-macos] launcher exited"
      break
    fi
    if [ "$i" -eq 60 ]; then
      # PID не умер за 30 с: не молчим — прерываем замену (бандл живой и
      # рабочий, пользователь запустит приложение сам).
      echo "[update-macos] ERROR: launcher PID $old_pid still alive after 30s, aborting"
      exit 1
    fi
    sleep 0.5
  done
  rm -f "$pid_file"
fi

# Final safety sleep.
sleep 1

echo "[update-macos] replacing $target_app → $new_app"

# Move old app aside. Ошибка mv НЕ глотается: при её игнорировании следующий
# cp -R копировал бы ВНУТРЬ оставшийся каталог (вложенный битый бандл без
# Info.plist на месте), а ветка восстановления смотрела бы на отсутствующий
# backup — тихая порча установки.
backup="${target_app}.old"
rm -rf "$backup"
if ! mv "$target_app" "$backup"; then
  echo "[update-macos] ERROR: cannot move old app aside, aborting (bundle untouched)"
  exit 1
fi

# Move new app into place; on failure restore the backup so the user
# isn't left without a launcher at all.
if ! cp -R "$new_app" "$target_app"; then
  echo "[update-macos] failed to install new app, restoring backup"
  mv "$backup" "$target_app" || true
  exit 1
fi

# Fix permissions.
chmod -R go-rwx "$target_app" || true

# Remove backup.
rm -rf "$backup"

# Clean up extracted zip dir.
rm -rf "$(dirname "$new_app")"

echo "[update-macos] update complete, launching $app_name"

# Re-launch the app — ПО ПУТИ к только что установленному бандлу:
# `open -a <имя>` спрашивал LaunchServices «любой .app с таким именем» и мог
# поднять старую копию из /Applications или ~/Downloads — обновление
# «не применялось» бы без всякой ошибки.
open "$target_app"