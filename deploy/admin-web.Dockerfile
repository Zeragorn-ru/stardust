# syntax=docker/dockerfile:1

# --- Сборка SPA админки ---
FROM node:20-alpine AS builder

WORKDIR /build

# Сначала манифесты — кэш слоя npm ci не инвалидируется при правке исходников.
COPY admin-web/package.json admin-web/package-lock.json ./
RUN npm ci

COPY admin-web/ ./
RUN npm run build

# --- Раздача статики + прокси на admin-server ---
FROM nginx:1.27-alpine AS admin-web

COPY deploy/admin-web.nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=builder /build/dist /usr/share/nginx/html

EXPOSE 80
