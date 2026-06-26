{
  description = "StarDust — Minecraft launcher (Tauri + React) и серверные сервисы";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
    rust-overlay = {
      url = "github:oxalica/rust-overlay";
      inputs.nixpkgs.follows = "nixpkgs";
    };
  };

  outputs = { self, nixpkgs, flake-utils, rust-overlay }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        overlays = [ (import rust-overlay) ];
        pkgs = import nixpkgs { inherit system overlays; };

        rustToolchain = pkgs.rust-bin.stable.latest.default.override {
          extensions = [ "rust-src" ];
        };

        # Нативные библиотеки, нужные Tauri-вебвью на Linux (webkit2gtk и пр.).
        # На NixOS это заменяет apt/pacman-пакеты: всё подтягивается герметично.
        tauriLibs = with pkgs; [
          webkitgtk_4_1
          gtk3
          cairo
          gdk-pixbuf
          glib
          dbus
          openssl
          librsvg
          libsoup_3
        ];

        tauriTools = with pkgs; [
          pkg-config
          gobject-introspection
          cargo-tauri
          nodejs_20
          wrapGAppsHook
        ];
      in
      {
        # Среда разработки: `nix develop`, затем `cd launcher && npm install && npm run tauri dev`.
        # AppImage из CI на NixOS не запускается (нет FHS), поэтому сборка идёт из исходников здесь.
        devShells.default = pkgs.mkShell {
          buildInputs = tauriLibs ++ tauriTools ++ [ rustToolchain ];

          # Без этого вебвью не находит .so в рантайме внутри dev-shell.
          shellHook = ''
            export LD_LIBRARY_PATH="${pkgs.lib.makeLibraryPath tauriLibs}:$LD_LIBRARY_PATH"
            export WEBKIT_DISABLE_COMPOSITING_MODE=1
            echo "StarDust dev-shell. Сборка лаунчера: cd launcher && npm install && npm run tauri build"
          '';
        };

        # Пакет лаунчера для NixOS (`nix build .#launcher`, запуск `nix run .#launcher`).
        # ВНИМАНИЕ: npmDepsHash ниже — плейсхолдер. Его нужно один раз посчитать на
        # машине с nix: запустите `nix build .#launcher`, скопируйте ожидаемый хэш
        # из ошибки и подставьте сюда. Без этого сборка пакета упадёт на этапе fetch.
        packages.launcher = pkgs.rustPlatform.buildRustPackage rec {
          pname = "stardust-launcher";
          version = "0.1.0";
          src = ./.;

          cargoLock = {
            lockFile = ./Cargo.lock;
          };

          # Фронтенд (Vite) собирается отдельно и кладётся в launcher/dist,
          # потому что tauri.conf.json ждёт готовый frontendDist.
          npmDeps = pkgs.fetchNpmDeps {
            src = ./launcher;
            hash = pkgs.lib.fakeHash; # <-- замените на реальный после первой сборки
          };

          nativeBuildInputs = tauriTools ++ [
            pkgs.npmHooks.npmConfigHook
            pkgs.makeWrapper
          ];
          buildInputs = tauriLibs;

          # Собираем фронт, затем нативный бандл Tauri.
          buildPhase = ''
            runHook preBuild
            ( cd launcher && npm run build )
            cargo tauri build --no-bundle
            runHook postBuild
          '';

          installPhase = ''
            runHook preInstall
            mkdir -p $out/bin
            install -Dm755 target/release/launcher $out/bin/stardust-launcher
            wrapProgram $out/bin/stardust-launcher \
              --prefix LD_LIBRARY_PATH : "${pkgs.lib.makeLibraryPath tauriLibs}"
            runHook postInstall
          '';

          meta = with pkgs.lib; {
            description = "StarDust Minecraft launcher";
            platforms = platforms.linux;
            license = licenses.mit;
          };
        };

        packages.default = self.packages.${system}.launcher;
      });
}
