#!/usr/bin/env bash
# Install Stardust launcher on Linux.
#
# Creates /opt/stardust-launcher/ with the AppImage,
# a symlink in /usr/local/bin/stardust, and a .desktop file.
# Requires root (sudo).
#
# Usage:
#   sudo bash install-linux.sh [path-to-AppImage]
#
# If no AppImage path is given, looks for stardust-launcher.AppImage in CWD.
set -euo pipefail

INSTALL_DIR="/opt/stardust-launcher"
BIN_LINK="/usr/local/bin/stardust"
DESKTOP_FILE="/usr/local/share/applications/stardust-launcher.desktop"
ICON_DIR="/usr/local/share/icons"

appimage="${1:-}"
if [ -z "$appimage" ]; then
  for candidate in stardust-launcher.AppImage StardustLauncher.AppImage stardust*.AppImage; do
    if [ -f "$candidate" ]; then
      appimage="$candidate"
      break
    fi
  done
fi

if [ -z "$appimage" ] || [ ! -f "$appimage" ]; then
  echo "Usage: sudo bash $0 <path-to-AppImage>"
  echo ""
  echo "No AppImage found. Download it from:"
  echo "  https://github.com/Zeragorn-ru/stardust/releases"
  exit 1
fi

if [ "$(id -u)" -ne 0 ]; then
  echo "This script must be run as root (sudo)."
  exit 1
fi

echo "Installing Stardust launcher…"
echo "  AppImage: $appimage"
echo "  Install dir: $INSTALL_DIR"

# Create install directory.
mkdir -p "$INSTALL_DIR"

# Copy AppImage.
cp -v "$appimage" "$INSTALL_DIR/stardust-launcher"
chmod +x "$INSTALL_DIR/stardust-launcher"

# Copy update helper scripts.
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
if [ -f "$SCRIPT_DIR/ci/update-linux.sh" ]; then
  cp -v "$SCRIPT_DIR/ci/update-linux.sh" "$INSTALL_DIR/update-linux.sh"
  chmod +x "$INSTALL_DIR/update-linux.sh"
fi

# Create symlink.
ln -sf "$INSTALL_DIR/stardust-launcher" "$BIN_LINK"
echo "Symlink: $BIN_LINK → $INSTALL_DIR/stardust-launcher"

# Create .desktop file.
mkdir -p "$(dirname "$DESKTOP_FILE")"
cat > "$DESKTOP_FILE" << 'DESKTOP'
[Desktop Entry]
Name=StarDust
Comment=StarDust Minecraft Launcher
Exec=/opt/stardust-launcher/stardust-launcher
Icon=stardust-launcher
Terminal=false
Type=Application
Categories=Game;
StartupWMClass=StarDust
DESKTOP
echo "Desktop entry: $DESKTOP_FILE"

# Install icon: .DirIcon/icon.png внутри AppImage (пакет самодостаточен
# иконкой); без неё Icon=stardust-launcher в .desktop висел в воздухе и в
# меню рисовалась дженерик-иконка. Отсутствие bsdtar/иконки — не ошибка
# установки: десктоп-запись уже создана и работает.
ICON_SIZE_DIR="$ICON_DIR/hicolor/512x512/apps"
EXTRACT_DIR="$(mktemp -d)"
appimage_abs="$(cd "$(dirname "$appimage")" && pwd)/$(basename "$appimage")"
if command -v bsdtar >/dev/null 2>&1; then
  if bsdtar -C "$EXTRACT_DIR" -xf "$appimage_abs" .DirIcon icon.png 2>/dev/null; then
    icon_src=""
    [ -f "$EXTRACT_DIR/.DirIcon" ] && icon_src="$EXTRACT_DIR/.DirIcon"
    [ -z "$icon_src" ] && [ -f "$EXTRACT_DIR/icon.png" ] && icon_src="$EXTRACT_DIR/icon.png"
    if [ -n "$icon_src" ]; then
      mkdir -p "$ICON_SIZE_DIR"
      cp "$icon_src" "$ICON_SIZE_DIR/stardust-launcher.png"
      echo "Icon: $ICON_SIZE_DIR/stardust-launcher.png"
    else
      echo "Icon: not found inside AppImage, skipping"
    fi
  fi
else
  echo "Icon: bsdtar not found, skipping (desktop entry still works)"
fi
rm -rf "$EXTRACT_DIR"
if command -v update-desktop-database >/dev/null 2>&1; then
  update-desktop-database "$(dirname "$DESKTOP_FILE")" || true
fi

echo ""
echo "Installation complete!"
echo "Run 'stardust' from terminal or find StarDust in your application menu."
