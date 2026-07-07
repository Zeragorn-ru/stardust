# StarDust Launcher — RPM spec (Fedora / RHEL / openSUSE).
#
# Сборка:
#   rpmbuild -ba packaging/fedora/stardust.spec
#
# Или из корня:
#   make pkg-fedora
#
# Перед сборкой положи исходники в ~/rpmbuild/SOURCES/stardust-0.0.0.tar.gz
# или задай Version/Release ниже и используй Source0 с GitHub archive.

Name:           stardust-launcher
Version:        0.0.0
Release:        1%{?dist}
Summary:        Minecraft launcher for the Stardust server (Tauri)
License:        MIT
URL:            https://github.com/Zeragorn-ru/stardust
# Source0:        https://github.com/Zeragorn-ru/stardust/archive/refs/tags/v%{version}/stardust-%{version}.tar.gz

BuildRequires:  rust cargo
BuildRequires:  nodejs npm
BuildRequires:  webkit2gtk4.1-devel
BuildRequires:  gtk3-devel
BuildRequires:  libappindicator-gtk3-devel
BuildRequires:  librsvg2-devel
BuildRequires:  patchelf

Requires:       webkit2gtk4.1
Requires:       gtk3
Requires:       libappindicator-gtk3
Requires:       librsvg2
Requires:       hicolor-icon-theme

%description
Desktop launcher for the Stardust Minecraft server platform.
Built with Tauri 2 (Rust + React).

%prep
# %setup -q -n stardust-%{version}
# Для локальной отладки из дерева репозитория раскомментируй и настрой пути.
%autosetup -n stardust-%{version} || true

%build
cd launcher
npm ci --ignore-scripts
npm run build
cargo build --manifest-path src-tauri/Cargo.toml --profile launcher-release
npm run tauri build -- --profile launcher-release --bundles rpm

%install
rpm_file="$(find ../target -name 'StarDust-*.rpm' -o -name 'stardust-*.rpm' | head -1)"
if [ -n "$rpm_file" ]; then
  rpm2cpio "$rpm_file" | cpio -idmv -D %{buildroot}
else
  install -D -m 0755 ../target/launcher-release/launcher %{buildroot}%{_bindir}/stardust-launcher
fi

%files
%license LICENSE
%{_bindir}/stardust-launcher
%{_datadir}/applications/com.stardust.launcher.desktop
%{_datadir}/icons/hicolor/*/apps/com.stardust.launcher.png

%changelog
* Tue Jul 07 2026 Stardust Team <dev@zeragorn.xyz> - 0.0.0-1
- Initial RPM packaging stub
