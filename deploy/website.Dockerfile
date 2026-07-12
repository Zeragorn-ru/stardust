# syntax=docker/dockerfile:1

# --- Сборка: просто копируем статику ---
FROM nginx:1.27-alpine AS website

COPY deploy/website.nginx.conf /etc/nginx/conf.d/default.conf
COPY website/ /usr/share/nginx/html

EXPOSE 80
