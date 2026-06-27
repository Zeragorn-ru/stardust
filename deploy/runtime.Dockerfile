# syntax=docker/dockerfile:1
#
# Рантайм-образы серверных сервисов. Компиляция сюда НЕ входит: бинари уже
# собраны в CI-джобе build (один прогон cargo на всё) и передаются как
# артефакты. Контекст сборки — каталог с готовым бинарём нужного сервиса.

# --- Общая база рантайма ---
FROM debian:bookworm-slim AS runtime-base
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# --- auth-server ---
FROM runtime-base AS auth-server
COPY auth-server /usr/local/bin/auth-server
# Внутри контейнера слушаем все интерфейсы; наружу пробрасываем через compose.
ENV AUTH_BIND=0.0.0.0:8080
EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/auth-server"]

# --- admin-server ---
FROM runtime-base AS admin-server
COPY admin-server /usr/local/bin/admin-server
ENV ADMIN_BIND=0.0.0.0:8081
# Каталог с байтами файлов сборок (монтируется volume через compose).
ENV MODPACK_DIR=/data/modpack
EXPOSE 8081
ENTRYPOINT ["/usr/local/bin/admin-server"]

# --- telegram-bot ---
# Тонкий сервис: только DATABASE_URL из окружения, токен берётся из БД.
# Портов и volume не требует, наружу ничего не публикует.
FROM runtime-base AS telegram-bot
COPY telegram-bot /usr/local/bin/telegram-bot
ENTRYPOINT ["/usr/local/bin/telegram-bot"]