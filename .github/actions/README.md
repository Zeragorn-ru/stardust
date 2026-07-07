# Launcher CI — composite actions

Каждый этап `launcher-release.yml` / `launcher-build.yml` — отдельный action
с полем `description` (видно в GitHub Actions UI при раскрытии шага).

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
| ⑧ | [`launcher-tauri-build`](launcher-tauri-build/) | всегда | `make build-launcher` |
| ⑨ | [`launcher-collect-bundles`](launcher-collect-bundles/) | always() | `make collect-launcher-bundles` |
| ⑩ | [`launcher-upload-ci-artifacts`](launcher-upload-ci-artifacts/) | always() | `dist/launcher-bundles/` |
| ⑪ | [`launcher-upload-release`](launcher-upload-release/) | тег | `scripts/ci/upload-launcher-release.sh` |

## Артефакты по платформам

| Платформа | Файлы в Release |
|-----------|-----------------|
| Windows | `StarDust_X.Y.Z_x64-setup.exe`, `bootstrap.exe` |
| Linux | `StarDust_X.Y.Z_amd64.deb`, `.rpm`, `.AppImage` |
| macOS | `StarDust_X.Y.Z_universal.dmg` |

### Как выглядит .dmg

Tauri собирает стандартный macOS disk image:

1. Пользователь открывает `.dmg` двойным кликом → монтируется том.
2. В Finder — окно с иконкой **StarDust.app** слева и папкой **Applications** справа.
3. Установка: перетащить приложение в Applications (классический drag-and-drop).
4. Внутри `.dmg` лежит universal-бинарь (Intel + Apple Silicon).

Путь сборки на runner:

```
target/universal-apple-darwin/release/bundle/dmg/StarDust_<version>_universal.dmg
```

`.app` bundle лежит отдельно в `bundle/macos/` — в Release грузится именно `.dmg`.

## Отладка

```sh
# Локально повторить сборку
make ci-launcher

# CI без тега, одна платформа
gh workflow run launcher-build.yml -f platform=macos

# Скачать артефакт последнего прогона
gh run download --name launcher-build-macos
```
