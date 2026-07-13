# Stardust — единая точка входа для локальной сборки и проверок.
# Версии инструментов совпадают с CI: Rust 1.96 (rust-toolchain.toml), Node 20, Java 21.

SHELL := /bin/bash
.DEFAULT_GOAL := help

LAUNCHER_PROFILE ?= launcher-release
CARGO ?= cargo
NPM ?= npm

.PHONY: help
help: ## Показать цели
	@grep -E '^[a-zA-Z0-9_.-]+:.*##' $(MAKEFILE_LIST) | sort | awk 'BEGIN {FS = ":.*## "}; {printf "  \033[36m%-22s\033[0m %s\n", $$1, $$2}'

# ─── Backend (Rust workspace) ───────────────────────────────────────────────

.PHONY: test-backend
test-backend: ## cargo test для backend-крейтов
	$(CARGO) test -p auth-server -p admin-server -p telegram-bot -p store -p protocol

.PHONY: build-backend
build-backend: ## release-сборка серверных бинарей
	$(CARGO) build --release -p auth-server -p admin-server -p telegram-bot

.PHONY: clippy-backend
clippy-backend: ## clippy для backend (без launcher)
	$(CARGO) clippy -p auth-server -p admin-server -p telegram-bot -p store -p protocol -- -D warnings

.PHONY: run-auth
run-auth: ## Запустить auth-server (127.0.0.1:8080)
	$(CARGO) run -p auth-server

.PHONY: run-admin
run-admin: ## Запустить admin-server (нужен DATABASE_URL)
	ADMIN_BIND=127.0.0.1:8081 $(CARGO) run -p admin-server

# ─── Launcher (Tauri) ───────────────────────────────────────────────────────

.PHONY: launcher-deps
launcher-deps: ## npm ci в launcher/
	cd launcher && $(NPM) ci --ignore-scripts

.PHONY: clippy-launcher
clippy-launcher: ## clippy лаунчера (профиль launcher-release)
	$(CARGO) clippy -p launcher --profile $(LAUNCHER_PROFILE) -- -D warnings

.PHONY: build-launcher-frontend
build-launcher-frontend: launcher-deps ## Собрать только React-часть
	cd launcher && $(NPM) run build

.PHONY: build-launcher
build-launcher: launcher-deps ## Собрать Tauri-лаунчер (установщики в target/)
	cd launcher && $(NPM) run tauri build -- --profile $(LAUNCHER_PROFILE)

.PHONY: dev-launcher
dev-launcher: launcher-deps ## Tauri dev (Vite + окно)
	cd launcher && $(NPM) run tauri dev

.PHONY: collect-launcher-bundles
collect-launcher-bundles: ## Собрать артефакты в dist/launcher-bundles/
	bash scripts/ci/collect-launcher-bundles.sh

.PHONY: bootstrap
bootstrap: ## Собрать bootstrap.exe (Windows NSIS updater)
	bash scripts/ci/build-bootstrap.sh

# ─── Admin web ────────────────────────────────────────────────────────────────

.PHONY: admin-web-deps
admin-web-deps: ## npm ci в admin-web/
	cd admin-web && $(NPM) ci

.PHONY: build-admin-web
build-admin-web: admin-web-deps ## Собрать admin-web SPA
	cd admin-web && $(NPM) run build

.PHONY: dev-admin-web
dev-admin-web: admin-web-deps ## Dev-сервер admin-web (:1430)
	cd admin-web && $(NPM) run dev

# ─── Website ──────────────────────────────────────────────────────────────────

.PHONY: website-deps
website-deps: ## npm ci в website/
	cd website && $(NPM) ci

.PHONY: build-website
build-website: website-deps ## Собрать публичный сайт
	cd website && $(NPM) run build

.PHONY: dev-website
dev-website: website-deps ## Dev-сервер публичного сайта (:5173)
	cd website && $(NPM) run dev

# ─── Minecraft mod ────────────────────────────────────────────────────────────

.PHONY: build-mod
build-mod: ## Собрать stardust-mod JAR
	cd stardust-mod && ./gradlew build

.PHONY: clean-mod
clean-mod: ## Очистить Gradle-сборку мода
	cd stardust-mod && ./gradlew clean

# ─── Агрегаты (как в CI) ──────────────────────────────────────────────────────

.PHONY: ci
ci: test-backend clippy-backend clippy-launcher build-admin-web build-website build-mod ## Все проверки без релизной сборки лаунчера

.PHONY: ci-launcher
ci-launcher: clippy-launcher build-launcher collect-launcher-bundles ## Полная сборка лаунчера + сбор артефактов

.PHONY: clean
clean: ## cargo clean + dist/
	$(CARGO) clean
	rm -rf dist/

# ─── Docker (backend) ─────────────────────────────────────────────────────────

.PHONY: docker-pull
docker-pull: ## docker compose pull (из deploy/)
	cd deploy && docker compose pull

.PHONY: docker-up
docker-up: ## docker compose up -d
	cd deploy && docker compose up -d

.PHONY: docker-update
docker-update: ## Обновить backend на сервере (deploy/update.sh)
	bash deploy/update.sh

# ─── Релизы ───────────────────────────────────────────────────────────────────

.PHONY: release-launcher
release-launcher: ## Патч-бамп тега лаунчера (scripts/release.sh)
	sh scripts/release.sh

.PHONY: release-launcher-dry-run
release-launcher-dry-run: ## Показать следующий тег лаунчера
	sh scripts/release.sh --dry-run

# ─── Нативная упаковка (заготовки) ────────────────────────────────────────────

.PHONY: pkg-arch
pkg-arch: ## Собрать Arch-пакет (makepkg, нужен packaging/arch/)
	cd packaging/arch && makepkg -sf

.PHONY: pkg-fedora
pkg-fedora: ## Собрать RPM (rpmbuild, нужен packaging/fedora/)
	rpmbuild -ba packaging/fedora/stardust.spec
