# stardust-mod-fabric

Fabric-версия мода Stardust для Minecraft 1.21.1 (Fabric Loader 0.16.x).
Параллельная ветка `stardust-mod` (NeoForge) — NeoForge-версия не удалена и
продолжает собираться как раньше (`mod-v*` теги).

## Отличия от NeoForge-версии

| Аспект | stardust-mod (NeoForge) | stardust-mod-fabric |
| --- | --- | --- |
| Метаданные | `META-INF/neoforge.mods.toml` | `fabric.mod.json` |
| Entrypoint | `StardustMod` (constructor + event bus) | `StardustFabricMod` (ModInitializer) |
| События | `NeoForge.EVENT_BUS` | Fabric API колбэки (ServerLifecycle, ServerMessage, UseBlock...) |
| Дроп лайт-блока | `BlockDropsEvent` | `LightBlockMixin.spawnAfterBreak` |
| Чат | `ServerChatEvent.setCanceled` | `ServerMessageEvents.ALLOW_CHAT_MESSAGE` → false |
| Маппинг имён | Mojang (NeoForge) | `officialMojangMappings()` — тот же, код логики идентичен |
| Конфиг-каталог | `FMLPaths.CONFIGDIR` | `FabricLoader.getConfigDir()` |

Классы логики (`StardustHttpProvider`, `StardustTabIntegration`,
`StardustChatNotifications`, `StardustBadgeConfig`, `StardustServerConfig`,
миксины кроме LightBlock) перенесены без изменений.

## Сборка

```
./gradlew build
```

Ресурсы (data/, assets/, миксины) синхронны с NeoForge-версией: при правке
одной из копий синхронизируй вторую.

## Релизы

Собирается CI (`scripts/ci/set-mod-version.sh` и workflow `mod-release.yml`
остаются общими с NeoForge — см. `ci.yml` target `mod`).
