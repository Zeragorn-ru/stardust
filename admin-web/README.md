# admin-web

Веб-админка (React + Vite + TypeScript) для управления сборкой (модпаком).
Ходит в `admin-server` с bearer-токеном админа.

## Разработка

```sh
npm install
npm run dev
```

Dev-сервер на `http://localhost:1430`, проксирует `/api`, `/manifest`,
`/files` на `admin-server` (`http://127.0.0.1:8081`). Запусти admin-server
отдельно с `ADMIN_BIND=127.0.0.1:8081` и `DATABASE_URL=...`.

## Сборка

```sh
npm run build
```

Статика собирается в `dist/`. В docker-образе её раздаёт nginx.
