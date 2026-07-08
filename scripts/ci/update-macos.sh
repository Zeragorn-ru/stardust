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
    sleep 0.5
  done
  rm -f "$pid_file"
fi

# Final safety sleep.
sleep 1

echo "[update-macos] replacing $target_app → $new_app"

# Move old app aside.
backup="${target_app}.old"
rm -rf "$backup"
mv "$target_app" "$backup" || true

# Move new app into place.
cp -R "$new_app" "$target_app"

# Fix permissions.
chmod -R go-rwx "$target_app" || true

# Remove backup.
rm -rf "$backup"

# Clean up extracted zip dir.
rm -rf "$(dirname "$new_app")"

echo "[update-macos] update complete, launching $app_name"

# Re-launch the app.
open -a "$app_name"
