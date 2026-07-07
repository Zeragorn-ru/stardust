#!/usr/bin/env bash
# Собирает bootstrap.exe для NSIS-обновлений (только Windows).
set -euo pipefail

root="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$root"

mkdir -p launcher/src-tauri/nsis

if [ -f crates/bootstrap/target/release/bootstrap.exe ]; then
  echo "Bootstrap cache hit, skipping build"
else
  echo "Building bootstrap from source"
  cargo clippy --manifest-path crates/bootstrap/Cargo.toml --release -- -D warnings
  cargo build --manifest-path crates/bootstrap/Cargo.toml --release
fi

cp -v crates/bootstrap/target/release/bootstrap.exe launcher/src-tauri/nsis/bootstrap.exe
