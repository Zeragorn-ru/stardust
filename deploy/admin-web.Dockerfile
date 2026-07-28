# syntax=docker/dockerfile:1

# --- Сборка SPA админки ---
FROM node:20-alpine AS builder

WORKDIR /build

# Сначала манифесты — кэш слоя npm ci не инвалидируется при правке исходников.
COPY admin-web/package.json admin-web/package-lock.json ./
# minecraft-skin-renderer ships a broken development postinstall hook; the
# renderer itself is bundled by Vite and does not require install scripts.
RUN npm ci --ignore-scripts

COPY admin-web/ ./
RUN npm run build

# --- Раздача статики + прокси на admin-server ---
FROM nginx:1.27-alpine AS admin-web

COPY deploy/admin-web.nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=builder /build/dist /usr/share/nginx/html

EXPOSE 80
