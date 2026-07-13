# syntax=docker/dockerfile:1

# --- Build Vite landing page ---
FROM node:20-alpine AS build

WORKDIR /app

COPY website/package.json website/package-lock.json ./
RUN npm ci

COPY website/ ./
RUN npm run build

# --- Runtime: nginx serves built assets ---
FROM nginx:1.27-alpine AS website

COPY deploy/website.nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist/ /usr/share/nginx/html/

EXPOSE 80
