# macOS: подпись и нотаризация StarDust

Диалог **«StarDust Not Opened»** — приложение не подписано Developer ID и не нотаризовано.

## GitHub Environment `launcher-release`

Секреты задаются в **Settings → Environments → launcher-release** (или repo secrets).
Workflow прокидывает их в `env:` job — composite actions только читают переменные окружения.

| Secret | Описание |
|--------|----------|
| `APPLE_CERTIFICATE` | base64 `.p12` (Developer ID Application) |
| `APPLE_CERTIFICATE_PASSWORD` | пароль экспорта `.p12` |
| `KEYCHAIN_PASSWORD` | пароль временного CI keychain |
| `APPLE_TEAM_ID` | Team ID |

**Нотаризация** (один из вариантов):

| API key (рекомендуется) | |
|-------------------------|---|
| `APPLE_API_ISSUER` | Issuer ID |
| `APPLE_API_KEY` | Key ID |
| `APPLE_API_KEY_BASE64` | base64 `AuthKey_XXX.p8` |

| Apple ID | |
|----------|---|
| `APPLE_ID` | email |
| `APPLE_PASSWORD` | app-specific password |
| `APPLE_TEAM_ID` | Team ID |

Опционально: `APPLE_SIGNING_IDENTITY` — если авто-детект не сработает.

## Экспорт сертификата

```sh
openssl base64 -A -in certificate.p12 -out certificate-base64.txt
# → APPLE_CERTIFICATE
```

## CI flow

1. Job `environment: launcher-release` (только macOS matrix)
2. `launcher-setup-macos-signing` → `scripts/ci/setup-macos-signing.sh`
3. `tauri-action` подписывает + нотаризует (env наследуется из job)

## Локально

```sh
security find-identity -v -p codesigning
export APPLE_SIGNING_IDENTITY="Developer ID Application: …"
make build-launcher
```

## DMG без подписи Apple

Подпись не обязательна для UX-улучшений DMG:

| Элемент | Описание |
|---------|----------|
| Фон DMG | `launcher/src-tauri/images/dmg-background.png` + `tauri.conf.json` → `bundle.macOS.dmg` |
| Гайд | [`docs/MACOS_INSTALL.md`](../../docs/MACOS_INSTALL.md) на GitHub |
| `.webloc` | `launcher/src-tauri/dmg/Установка.webloc` — CI вшивает в DMG (`inject-dmg-webloc.sh`) |

Пользователь: drag-and-drop в Applications, при Gatekeeper — ПКМ → Open. Двойной клик **Установка** в DMG открывает гайд.

## Обход для себя (не для пользователей)

ПКМ → Open → Open, или System Settings → Privacy & Security → Open Anyway.
