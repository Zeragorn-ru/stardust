#!/usr/bin/env bash
# Импорт Apple Developer ID сертификата в временный keychain на CI-runner.
# Переменные APPLE_* приходят из job env workflow (environment launcher-release).
set -euo pipefail

if [ -z "${APPLE_CERTIFICATE:-}" ]; then
  echo "::warning::APPLE_CERTIFICATE not set — building unsigned macOS app (Gatekeeper will block)."
  exit 0
fi

: "${APPLE_CERTIFICATE_PASSWORD:?APPLE_CERTIFICATE_PASSWORD is required when APPLE_CERTIFICATE is set}"
: "${KEYCHAIN_PASSWORD:?KEYCHAIN_PASSWORD is required when APPLE_CERTIFICATE is set}"

KEYCHAIN_PATH="$RUNNER_TEMP/build.keychain-db"
CERT_PATH="$RUNNER_TEMP/certificate.p12"

echo "$APPLE_CERTIFICATE" | base64 --decode > "$CERT_PATH"

security create-keychain -p "$KEYCHAIN_PASSWORD" "$KEYCHAIN_PATH"
security default-keychain -s "$KEYCHAIN_PATH"
security unlock-keychain -p "$KEYCHAIN_PASSWORD" "$KEYCHAIN_PATH"
security set-keychain-settings -t 3600 -u "$KEYCHAIN_PATH"
security import "$CERT_PATH" -k "$KEYCHAIN_PATH" -P "$APPLE_CERTIFICATE_PASSWORD" -T /usr/bin/codesign -T /usr/bin/security -T /usr/bin/productsign
security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "$KEYCHAIN_PASSWORD" "$KEYCHAIN_PATH"

echo "==> Available signing identities:"
security find-identity -v -p codesigning "$KEYCHAIN_PATH"

# Self-signed сертификаты (без Apple-корня) не валидны, пока им явно не доверять.
# Доверяем корневому сертификату импортированного p12 — работает и для Developer ID.
# OpenSSL 3 читает legacy-форматы p12 (RC2/3DES) только с -legacy — пробуем оба варианта.
openssl pkcs12 -legacy -in "$CERT_PATH" -passin pass:"$APPLE_CERTIFICATE_PASSWORD" -nokeys -clcerts \
  -out "$RUNNER_TEMP/leaf.pem" 2>/dev/null \
  || openssl pkcs12 -in "$CERT_PATH" -passin pass:"$APPLE_CERTIFICATE_PASSWORD" -nokeys -clcerts \
       -out "$RUNNER_TEMP/leaf.pem" 2>/dev/null
# Без sudo на headless-раннере add-trusted-cert вечно ждёт GUI-подтверждения trust.
security add-trusted-cert -d -r trustRoot -k "$KEYCHAIN_PATH" "$RUNNER_TEMP/leaf.pem" 2>/dev/null \
  || sudo security add-trusted-cert -d -r trustRoot -k "$KEYCHAIN_PATH" "$RUNNER_TEMP/leaf.pem" \
  || security add-trusted-cert -r trustRoot -k "$KEYCHAIN_PATH" "$RUNNER_TEMP/leaf.pem"

if [ -z "${APPLE_SIGNING_IDENTITY:-}" ]; then
  # Сначала ищем Developer ID, затем — любой валидный codesigning identity (self-signed).
  APPLE_SIGNING_IDENTITY=$(security find-identity -v -p codesigning "$KEYCHAIN_PATH" | grep 'Developer ID Application' | head -1 | sed -E 's/.*"([^"]+)".*/\1/' || true)
  if [ -z "$APPLE_SIGNING_IDENTITY" ]; then
    APPLE_SIGNING_IDENTITY=$(security find-identity -v -p codesigning "$KEYCHAIN_PATH" | grep -v "valid identities" | head -1 | sed -E 's/.*"([^"]+)".*/\1/' || true)
  fi
  if [ -n "$APPLE_SIGNING_IDENTITY" ]; then
    echo "APPLE_SIGNING_IDENTITY=$APPLE_SIGNING_IDENTITY" >> "$GITHUB_ENV"
    echo "Detected signing identity: $APPLE_SIGNING_IDENTITY"
  else
    echo "::error::Developer ID Application identity not found in imported certificate"
    exit 1
  fi
else
  echo "Using APPLE_SIGNING_IDENTITY from env"
fi

if [ -n "${APPLE_API_KEY_BASE64:-}" ] && [ -n "${APPLE_API_KEY:-}" ]; then
  API_KEY_PATH="$RUNNER_TEMP/AuthKey_${APPLE_API_KEY}.p8"
  echo "$APPLE_API_KEY_BASE64" | base64 --decode > "$API_KEY_PATH"
  chmod 600 "$API_KEY_PATH"
  echo "APPLE_API_KEY_PATH=$API_KEY_PATH" >> "$GITHUB_ENV"
  echo "Wrote App Store Connect API key to $API_KEY_PATH"
fi

echo "macOS signing keychain ready."
