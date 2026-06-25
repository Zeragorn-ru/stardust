# syntax=docker/dockerfile:1

# --- Сборка только auth-server (Tauri-крейт не собираем: ему нужны GUI-библиотеки) ---
FROM rust:1-bookworm AS builder

WORKDIR /build

COPY Cargo.toml Cargo.lock ./
COPY crates ./crates
# Манифест Tauri-крейта нужен, чтобы воркспейс разрешился. Исходники не
# копируем и не собираем — кладём заглушку, на которую ссылается [lib].
COPY launcher/src-tauri/Cargo.toml ./launcher/src-tauri/Cargo.toml
RUN mkdir -p launcher/src-tauri/src && echo '' > launcher/src-tauri/src/lib.rs

RUN cargo build --release -p auth-server

# --- Рантайм ---
FROM debian:bookworm-slim AS runtime

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY --from=builder /build/target/release/auth-server /usr/local/bin/auth-server

# Внутри контейнера слушаем все интерфейсы; наружу пробрасываем через compose.
ENV AUTH_BIND=0.0.0.0:8080
EXPOSE 8080

ENTRYPOINT ["/usr/local/bin/auth-server"]
