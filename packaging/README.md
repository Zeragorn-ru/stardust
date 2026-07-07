# Нативная упаковка StarDust

Заготовки для дистрибутивов, где GitHub Release-артефакты не подходят или нужна
сборка из исходников.

## Что собирает CI (GitHub Releases, тег `vX.Y.Z`)

| Платформа | Артефакты |
|-----------|-----------|
| Windows | `*-setup.exe` (NSIS), `bootstrap.exe` |
| macOS | universal `.dmg` |
| Linux (ubuntu-22.04) | `.deb`, `.rpm`, `.AppImage` |

Локально повторить CI-сборку лаунчера:

```sh
make ci-launcher
# артефакты: dist/launcher-bundles/
```

## Каталоги

| Путь | Назначение |
|------|------------|
| [`arch/PKGBUILD`](arch/PKGBUILD) | Arch / Manjaro (`makepkg -si`) |
| [`fedora/stardust.spec`](fedora/stardust.spec) | Fedora / RHEL / openSUSE (`rpmbuild -ba`) |
| [`homebrew/stardust.rb`](homebrew/stardust.rb) | macOS Homebrew (formula stub) |
| [`flatpak/com.stardust.launcher.yml`](flatpak/com.stardust.launcher.yml) | Flatpak (stub, нужна доработка node-модуля) |

## Arch Linux

```sh
# зависимости
sudo pacman -S base-devel nodejs npm rust webkit2gtk-4.1 gtk3 libappindicator-gtk3 librsvg patchelf

make pkg-arch
# или
cd packaging/arch && makepkg -si
```

Перед релизом обнови `pkgver` в PKGBUILD на версию тега (без `v`).

## Fedora / RPM

```sh
sudo dnf install rpm-build rpmdevtools nodejs npm rust cargo \
  webkit2gtk4.1-devel gtk3-devel libappindicator-gtk3-devel librsvg2-devel patchelf

make pkg-fedora
```

Для официальной сборки упакуй tarball тега в `~/rpmbuild/SOURCES/` и раскомментируй
`Source0` в spec-файле.

## NixOS

Сборка из корня репозитория через [`flake.nix`](../flake.nix):

```sh
nix develop
nix build .#launcher
```

## Системные зависимости (сборка Tauri)

```sh
# Debian / Ubuntu
bash scripts/ci/setup-linux-deps.sh

# Arch
sudo pacman -S webkit2gtk-4.1 gtk3 libappindicator-gtk3 librsvg patchelf
```
