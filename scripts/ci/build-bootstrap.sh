#!/usr/bin/env bash
# Собирает bootstrap.exe для NSIS-обновлений (только Windows).
set -euo pipefail

root="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$root"

mkdir -p launcher/src-tauri/nsis

# Кеш содержит промежуточные файлы, а не источник правды: cargo сам проверит
# исходники и include_bytes! с иконкой, даже после восстановления старого кеша.
echo "Building bootstrap from source (incremental cache)"
cargo clippy --manifest-path crates/bootstrap/Cargo.toml --release -- -D warnings
cargo build --manifest-path crates/bootstrap/Cargo.toml --release

cp -v crates/bootstrap/target/release/bootstrap.exe launcher/src-tauri/nsis/bootstrap.exe
