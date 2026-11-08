#!/usr/bin/env bash
set -u

# Измеряет локальные build-time и размер артефактов. Это не benchmark: результаты
# зависят от машины, состояния кэшей и версии инструментов.

ROOT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)

if ! command -v /usr/bin/time >/dev/null 2>&1; then
  printf '%s\n' "error: /usr/bin/time is required" >&2
  exit 1
fi

printf 'Stardust performance baseline\n'
printf 'Recorded at: %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
printf 'Host: %s\n' "$(uname -srm)"
printf 'Node: %s\n' "$(node --version 2>/dev/null || printf 'unavailable')"
printf 'Cargo: %s\n' "$(cargo --version 2>/dev/null || printf 'unavailable')"
printf '\n'

run_frontend() {
  local name=$1
  local directory=$2
  local output_dir=$3
  local log_file
  log_file=$(mktemp)

  printf '## %s\n' "$name"
  if [[ ! -d "$ROOT_DIR/$directory" ]]; then
    printf 'status: skipped (directory not found)\n\n'
    return 0
  fi

  if [[ ! -d "$ROOT_DIR/$directory/node_modules" ]]; then
    printf 'status: skipped (node_modules not found; run npm ci in %s)\n\n' "$directory"
    return 0
  fi

  local start_ns end_ns elapsed_ms status
  start_ns=$(date +%s%N)
  set +e
  (cd "$ROOT_DIR/$directory" && /usr/bin/time -p npm run build >"$log_file" 2>&1)
  status=$?
  set -e
  end_ns=$(date +%s%N)
  elapsed_ms=$(( (end_ns - start_ns) / 1000000 ))

  printf 'status: %s\n' "$([[ $status -eq 0 ]] && printf success || printf failed)"
  printf 'build_time_ms: %s\n' "$elapsed_ms"
  if [[ -d "$ROOT_DIR/$directory/$output_dir" ]]; then
    printf 'dist_bytes: %s\n' "$(du -sk "$ROOT_DIR/$directory/$output_dir" | awk '{print $1 * 1024}')"
    printf 'dist_files: %s\n' "$(find "$ROOT_DIR/$directory/$output_dir" -type f -print | wc -l | tr -d ' ')"
  else
    printf 'dist_bytes: unavailable (output directory not created)\n'
    printf 'dist_files: unavailable (output directory not created)\n'
  fi
  if [[ $status -ne 0 ]]; then
    printf 'build_log: %s\n' "$log_file"
    sed -n '1,12p' "$log_file" >&2
    return 0
  fi
  rm -f "$log_file"
  printf '\n'
}

run_backend() {
  printf '## Backend release build\n'
  local start_ns end_ns elapsed_ms status
  start_ns=$(date +%s%N)
  set +e
  (cd "$ROOT_DIR" && /usr/bin/time -p cargo build --release -p auth-server -p admin-server -p telegram-bot)
  status=$?
  set -e
  end_ns=$(date +%s%N)
  elapsed_ms=$(( (end_ns - start_ns) / 1000000 ))
  printf 'status: %s\n' "$([[ $status -eq 0 ]] && printf success || printf failed)"
  printf 'build_time_ms: %s\n' "$elapsed_ms"
  if [[ $status -ne 0 ]]; then
    printf 'note: backend build did not complete successfully; see cargo output above\n'
  fi
  return 0
}

set -e
run_frontend "Launcher frontend" "launcher" "dist"
run_frontend "Admin web" "admin-web" "dist"
run_frontend "Website" "website" "dist"
run_backend
