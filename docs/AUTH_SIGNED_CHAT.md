# Аутентификация и подписанный чат Minecraft

## Причина ошибки

`Bad signature length: got 1 but was expecting 512` появляется не из-за
шифрования текста. Это проверка RSA-подписи ключа профиля Minecraft.
Upstream `authlib-injector` намеренно возвращает для
`/player/certificates` фиктивную подпись `AA==` (один байт). Paper 1.21.1
ожидает RSA-подпись 2048 бит (256 байт; в сообщении Java — 512 hex-символов)
и пишет эту ошибку.

Лаунчер теперь читает `meta.feature.enable_profile_key` из auth-server и
передаёт `-Dauthlibinjector.profileKey=enabled` только при включённой серверной
поддержке. При выключенном флаге используется `disabled`, поэтому случайный
upstream injector не может включить фиктивный сертификат незаметно.

## Реализованный endpoint

Auth-server поддерживает совместимый endpoint:

```text
POST /minecraftservices/player/certificates
Authorization: Bearer <session-token>
```

Он включается только при `AUTH_ENABLE_PROFILE_KEY=true`. Ответ содержит
RSA-2048 key pair, `expiresAt`, `refreshedAfter`, `publicKeySignature` и
`publicKeySignatureV2`. Подписи создаются постоянным ключом из `AUTH_KEY_PATH`,
который также публикуется как `signaturePublickey` в Yggdrasil-метаданных.

В deployment StarDust `AUTH_ENABLE_PROFILE_KEY` теперь включён по умолчанию;
для аварийного rollback его можно явно установить в `false`. Ключ
`AUTH_KEY_PATH` должен храниться в постоянном volume и не меняться при
перезапуске контейнера.

## Версии и публикация injector

Сборка закреплённого форка выполняется workflow
`.github/workflows/authlib-injector-release.yml`. Версии публикуются отдельными
тегами вида `authlib-injector-v0.1.0`; вместе с jar публикуются `.sha256` и
JSON-метаданные. Релиз `authlib-injector-stable` обновляется workflow как
совместимый алиас последней версии.

Admin-server предоставляет:

- `GET /authlib-injector/latest.json` — текущая версия и SHA-256;
- `GET /authlib-injector.jar` — jar последней версии.

Лаунчер проверяет metadata при каждом запуске и автоматически заменяет jar,
если появилась новая версия или изменился checksum. Admin-панель также
скачивает последнюю сборку по той же ссылке. Upstream injector по-прежнему не
используется.

## Настройка настоящего secure chat

Для настоящих подписанных сообщений нужны все условия:

1. На клиенте и сервере используется StarDust-сборка injector из
   `third_party/authlib-injector`, а не upstream jar с `AA==`.
2. Сервер Paper/Spigot запускается с этим injector. Он проверяет сертификат
   профиля ключом auth-server, а затем обычным RSA-ключом проверяет подписи
   сообщений.
3. На одиночном Paper-сервере установлены `online-mode=true` и
   `enforce-secure-profile=true`; для прокси настройки применяются к прокси и
   backend-серверам согласно документации injector.
4. В auth-server включён `AUTH_ENABLE_PROFILE_KEY=true`, а `AUTH_KEY_PATH`
   хранится в постоянном volume.

Нельзя выдавать кастомному аккаунту Mojang-подписанный сертификат: приватный
ключ Mojang недоступен. В этой схеме сертификат подписывает StarDust auth-server,
а StarDust injector доверяет его публичному ключу. Подписанный чат обеспечивает
аутентичность и целостность сообщений; шифрование канала — отдельный уровень.

## Источники

- [Yggdrasil Server Technical Specification](https://yushijinhun.github.io/authlib-injector/en/yggdrasil-server-technical-specification.html)
- [authlib-injector README: profileKey](https://github.com/yushijinhun/authlib-injector/blob/develop/README.en.md)
- [authlib-injector secure chat discussion](https://github.com/yushijinhun/authlib-injector/discussions/158)
- [authlib-injector server setup](https://yushijinhun.github.io/authlib-injector/en/using-authlib-injector-on-a-minecraft-server.html)
