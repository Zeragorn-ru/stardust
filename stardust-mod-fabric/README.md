# stardust-mod-fabric

Fabric-версия мода Stardust для Minecraft **26.2** (Fabric Loader 0.19.x–0.20.x,
Java 25). Параллельная ветка `stardust-mod` (NeoForge, 1.21.1) — не удалена и
продолжает собираться как раньше (`mod-v*` теги несут оба jar).

## Отличия от NeoForge-версии

| Аспект | stardust-mod (NeoForge) | stardust-mod-fabric |
| --- | --- | --- |
| Minecraft | 1.21.1 | 26.2 |
| Метаданные | `META-INF/neoforge.mods.toml` | `fabric.mod.json` |
| Entrypoint | `StardustMod` (constructor + event bus) | `StardustFabricMod` (ModInitializer) |
| События | `NeoForge.EVENT_BUS` | Fabric API колбэки (ServerLifecycle, ServerMessage, UseBlock...) |
| Дроп лайт-блока | `BlockDropsEvent` | `LightBlockMixin.spawnAfterBreak` |
| Чат | `ServerChatEvent.setCanceled` | `ServerMessageEvents.ALLOW_CHAT_MESSAGE` → false |
| Маппинг имён | Mojang (NeoForge) | без маппингов: с 26.x Minecraft не обфусцирован (loom non-obf) |
| Конфиг-каталог | `FMLPaths.CONFIGDIR` | `FabricLoader.getConfigDir()` |

## Маппинги и переименования 26.x

С Minecraft 26.x Mojang больше не публикует `client_mappings`, а Fabric —
intermediary: игра поставляется **необфусцированной**. Поэтому:

- plugin id — `net.fabricmc.fabric-loom` (non-obf путь, loom 1.14+ пропускает
  весь remapping); строка `mappings` в `build.gradle` отсутствует;
- код компилируется напрямую против классов игры, имена — «как в исходниках»
  26.2, которые ЧАСТИЧНО отличаются от Mojang-имён 1.21.1. Ключевые отличия,
  учтённые в коде:
  - `ResourceLocation` → `Identifier` (тот же пакет `net.minecraft.resources`);
  - `Entity.getServer()` удалён → `player.level().getServer()`;
  - `Level.isClientSide` (поле) → `isClientSide()` (метод); `level.random` → `getRandom()`;
  - `InteractionResultHolder` удалён → `UseItemCallback` возвращает
    `InteractionResult`; `sidedSuccess(bool)` → `SUCCESS` / `CONSUME`;
  - `ClickEvent`/`HoverEvent` стали интерфейсами → record-реализации
    `ClickEvent.SuggestCommand`, `HoverEvent.ShowText`;
  - `GameProfile.getName()/getId()` → `name()/id()` (authlib стал record);
  - `source.hasPermission(int)` → `Commands.LEVEL_MODERATORS.check(source.permissions())`;
  - `PlayerAdvancements.grant` → `award` (mixin целится в `award`);
  - медные блоки стали `WeatheringCopperCollection` →
    `Blocks.COPPER_BLOCK.weathering().pick(WeatherState.OXIDIZED)` и т.д.;
  - `playNotifySound` удалён → `Player.playSound(SoundEvent, float, float)`.

## Сборка

```
./gradlew build
```

Требуется JDK 25 и Gradle 9.8.2. Минимум 25 нужен не только для компиляции,
но и для самого Gradle: loom 1.19.x собран под JVM 25 и на Java 21 не
запускается. В CI оба каталога собираются отдельными job'ами (ci.yml: `mod`
на temurin 21, `mod-fabric` на temurin 25) — NeoForge остаётся на Gradle 8.x
и Java 21, общий runner для них невозможен. foojay-resolver в settings.gradle
докатывает JDK 25 для toolchain, если в системе стоит только 21.

Ресурсы (data/, assets/, миксины) синхронны с NeoForge-версией: при правке
одной из копий синхронизируй вторую (Java-код синхронным быть НЕ может —
имена API разные).

## Релизы

Собирается CI (`scripts/ci/set-mod-version.sh` и workflow `mod-release.yml`
остаются общими с NeoForge — см. `ci.yml` target `mod`). Имя артефакта —
`stardust-mod-fabric-<ver>.jar`; `deploy-mod` в admin-server выбирает jar по
`loader_kind` активной сборки.
