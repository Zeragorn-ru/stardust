# Homebrew formula stub for StarDust Launcher.
#
# Публикация (после настройки):
#   brew install --build-from-source packaging/homebrew/stardust.rb
#
# Для tap создай отдельный репозиторий zeragorn-ru/homebrew-stardust
# и обновляй url/sha256 на каждый релиз vX.Y.Z.

class Stardust < Formula
  desc "Minecraft launcher for the Stardust server"
  homepage "https://github.com/Zeragorn-ru/stardust"
  # url "https://github.com/Zeragorn-ru/stardust/archive/refs/tags/v0.7.22.tar.gz"
  # sha256 "REPLACE_WITH_SHA256"
  license "MIT"
  head "https://github.com/Zeragorn-ru/stardust.git", branch: "master"

  depends_on "node@20"
  depends_on "rust" => :build
  depends_on "pkg-config" => :build

  def install
    cd "launcher" do
      system "npm", "ci", "--ignore-scripts"
      system "npm", "run", "build"
      system "cargo", "build", "--manifest-path", "src-tauri/Cargo.toml", "--profile", "launcher-release"
      system "npm", "run", "tauri", "build", "--", "--profile", "launcher-release", "--bundles", "app"
    end

  # Путь к .app после tauri build — уточни под фактический output universal-apple-darwin.
    app = Dir["../target/**/bundle/macos/*.app"].first
    raise "StarDust.app not found after build" unless app

    prefix.install app => "StarDust.app"
    bin.write_exec_script <<~EOS
      #!/bin/bash
      exec "#{prefix}/StarDust.app/Contents/MacOS/launcher" "$@"
    EOS
  end

  test do
    assert_path_exists prefix/"StarDust.app"
  end
end
