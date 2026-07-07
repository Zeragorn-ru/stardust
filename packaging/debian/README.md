# Debian packaging notes — StarDust Launcher
#
# CI уже собирает .deb через Tauri (см. launcher-release.yml, ubuntu-22.04).
# Этот каталог — для ручной пересборки или кастомного debian/rules.
#
# Быстрый путь (как в CI):
#   make ci-launcher
#   ls dist/launcher-bundles/*.deb
#
# Сборка из исходников на Debian/Ubuntu:
#   bash scripts/ci/setup-linux-deps.sh
#   cd launcher && npm ci && npm run tauri build -- --profile launcher-release --bundles deb
#
# Зависимости рантайма (пример для control):
#   Depends: libwebkit2gtk-4.1-0, libgtk-3-0, libappindicator3-1, librsvg2-2
