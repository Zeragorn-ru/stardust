#!/usr/bin/env bash
# Кросс-платформенный SHA-256 файла (Linux: sha256sum, macOS: shasum).
set -euo pipefail

file="${1:?usage: sha256-file.sh <file>}"
if command -v sha256sum >/dev/null 2>&1; then
  sha256sum "$file" | awk '{print $1}'
elif command -v shasum >/dev/null 2>&1; then
  shasum -a 256 "$file" | awk '{print $1}'
else
  echo "ERROR: neither sha256sum nor shasum found" >&2
  exit 1
fi
