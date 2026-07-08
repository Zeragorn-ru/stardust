#!/usr/bin/env bash
# Linux auto-update helper: replaces AppImage while launcher is exiting.
#
# Called by the launcher (update.rs) after downloading the new AppImage.
# Arguments:
#   $1 = path to new AppImage
#   $2 = path to current AppImage (being replaced)
set -euo pipefail

new_bin="$1"
target_bin="$2"

# Wait for the running launcher to fully exit.
pid_file="${target_bin}.update-pid"
if [ -f "$pid_file" ]; then
  old_pid=$(cat "$pid_file")
  echo "[update-linux] waiting for launcher PID $old_pid to exit…"
  for i in $(seq 1 60); do
    if ! kill -0 "$old_pid" 2>/dev/null; then
      echo "[update-linux] launcher exited"
      break
    fi
    sleep 0.5
  done
  rm -f "$pid_file"
fi

# Final safety sleep.
sleep 1

echo "[update-linux] replacing $target_bin → $new_bin"

# Move old binary aside.
backup="${target_bin}.old"
rm -f "$backup"
mv "$target_bin" "$backup" 2>/dev/null || true

# Move new binary into place.
mv "$new_bin" "$target_bin"
chmod +x "$target_bin"

# Remove backup.
rm -f "$backup"

echo "[update-linux] update complete, launching"

# Re-launch.
exec "$target_bin" &
