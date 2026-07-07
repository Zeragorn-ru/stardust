# Launcher CI — composite actions

Каждый этап `launcher-release.yml` / `launcher-build.yml` — отдельный action
с полем `description` (видно в GitHub Actions UI при раскрытии шага).

**Секреты** (`GITHUB_TOKEN`, `APPLE_*`, `GH_TOKEN`) задаются в `env:` на уровне
job в workflow — composite actions их **не** объявляют.

macOS job использует GitHub Environment **`launcher-release`** (Settings →
Environments) для Apple signing secrets.

## Пайплайн

| # | Action | Когда | Локальный аналог |
|---|--------|-------|------------------|
| ① | [`launcher-setup-linux`](launcher-setup-linux/) | ubuntu-22.04 | `bash scripts/ci/setup-linux-deps.sh` |
| ② | [`launcher-setup-toolchain`](launcher-setup-toolchain/) | всегда | `rust-toolchain.toml`, Node 20 |
| ③ | [`launcher-install-deps`](launcher-install-deps/) | всегда | `make launcher-deps` |
| ④ | [`launcher-clippy`](launcher-clippy/) | всегда | `make clippy-launcher` |
| ⑤ | [`launcher-build-bootstrap`](launcher-build-bootstrap/) | Windows + релиз | `make bootstrap` |
| ⑥ | [`launcher-set-version`](launcher-set-version/) | тег / manual | `scripts/ci/set-launcher-version.sh` |
| ⑦ | [`launcher-wait-token`](launcher-wait-token/) | тег | — |
| ⑦b | [`launcher-setup-macos-signing`](launcher-setup-macos-signing/) | macOS | [`packaging/macos/README.md`](../packaging/macos/README.md) |
| ⑧ | [`launcher-tauri-build`](launcher-tauri-build/) | всегда | `make build-launcher` |
| ⑧b | [`launcher-inject-dmg-webloc`](launcher-inject-dmg-webloc/) | macOS | `scripts/ci/inject-dmg-webloc.sh` |
| ⑨ | [`launcher-collect-bundles`](launcher-collect-bundles/) | always() | `make collect-launcher-bundles` |
| ⑩ | [`launcher-upload-ci-artifacts`](launcher-upload-ci-artifacts/) | always() | `dist/launcher-bundles/` |
| ⑪ | [`launcher-upload-release`](launcher-upload-release/) | тег | `scripts/ci/upload-launcher-release.sh` |

## Сбор артефактов

`collect-launcher-bundles.sh` ищет рекурсивно:

```sh
find target -path '*/bundle/*' -type f \( -name '*.exe' -o -name '*.dmg' … \)
```

Покрывает все профили (`launcher-release`) и triple (`universal-apple-darwin`).

Checksums: `scripts/ci/sha256-file.sh` (Linux `sha256sum`, macOS `shasum`).

## Артефакты по платформам

| Платформа | Файлы в Release |
|-----------|-----------------|
| Windows | `StarDust_X.Y.Z_x64-setup.exe`, `bootstrap.exe` |
| Linux | `StarDust_X.Y.Z_amd64.deb`, `.rpm`, `.AppImage` |
| macOS | `StarDust_X.Y.Z_universal.dmg` (+ `Установка.webloc` внутри DMG) |

DMG: кастомный фон (`images/dmg-background.png`), гайд [`docs/MACOS_INSTALL.md`](../../docs/MACOS_INSTALL.md).

**Gatekeeper:** без Apple Developer ID + нотаризации macOS покажет *«StarDust Not Opened»*.
Настройка: [`packaging/macos/README.md`](../packaging/macos/README.md).

## Отладка

```sh
make ci-launcher
gh workflow run launcher-build.yml -f platform=macos
gh run download --name launcher-build-macos
```
