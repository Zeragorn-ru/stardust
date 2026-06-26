# syntax=docker/dockerfile:1

# --- Общий билдер: собирает оба серверных бинаря из воркспейса ---
# Tauri-крейт не собираем (ему нужны GUI-библиотеки) — кладём заглушку,
# чтобы воркспейс разрешился.
FROM rust:1-bookworm AS builder

WORKDIR /build

COPY Cargo.toml Cargo.lock ./
COPY crates ./crates
COPY launcher/src-tauri/Cargo.toml ./launcher/src-tauri/Cargo.toml
RUN mkdir -p launcher/src-tauri/src && echo '' > launcher/src-tauri/src/lib.rs

RUN cargo build --release -p auth-server -p admin-server -p telegram-bot

# --- Общая база рантайма ---
FROM debian:bookworm-slim AS runtime-base
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# --- auth-server ---
FROM runtime-base AS auth-server
COPY --from=builder /build/target/release/auth-server /usr/local/bin/auth-server
# Внутри контейнера слушаем все интерфейсы; наружу пробрасываем через compose.
ENV AUTH_BIND=0.0.0.0:8080
EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/auth-server"]

# --- admin-server ---
FROM runtime-base AS admin-server
COPY --from=builder /build/target/release/admin-server /usr/local/bin/admin-server
ENV ADMIN_BIND=0.0.0.0:8081
# Каталог с байтами файлов сборок (монтируется volume через compose).
ENV MODPACK_DIR=/data/modpack
EXPOSE 8081
ENTRYPOINT ["/usr/local/bin/admin-server"]

# --- telegram-bot ---
# Тонкий сервис: только DATABASE_URL из окружения, токен берётся из БД.
# Портов и volume не требует, наружу ничего не публикует.
FROM runtime-base AS telegram-bot
COPY --from=builder /build/target/release/telegram-bot /usr/local/bin/telegram-bot
ENTRYPOINT ["/usr/local/bin/telegram-bot"]
