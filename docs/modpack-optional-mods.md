# Рекомендации: опциональные моды (NeoForge 1.21.1)

Список для добавления в сборку через админку как **optional** client-моды.
Проверено по Modrinth API (`loaders=neoforge`, `game_versions=1.21.1`) на 2026-07-16.
В манифест ничего не добавлялось — только рекомендации.

Конфликты в лаунчере: Distant Horizons ↔ Voxy (статика + поле `conflictsWith` в `FileEntry`).

## Производительность / оптимизация

| Мод | Slug | Статус | Заметки |
|-----|------|--------|---------|
| **Sodium** | `sodium` | OK NeoForge 1.21.1 | Предпочтительный рендер-оптимизатор. Не ставить вместе с Embeddium. |
| **Lithium** | `lithium` | OK | Серверная/общая логика; полезен и на клиенте. |
| **Iris** | `iris` | OK (beta-линейка) | Шейдеры поверх Sodium. |
| **FerriteCore** | `ferrite-core` | OK | Меньше RAM на моделях/реестрах. |
| **Entity Culling** | `entityculling` | OK | Не рисует сущности вне FOV. |
| **ImmediatelyFast** | `immediatelyfast` | OK | Быстрее batching UI/частиц. |
| **ModernFix** | `modernfix` | OK | Общие фиксы и ускорения загрузки. |
| **MoreCulling** | `moreculling` | OK | Доп. culling блоков/сущностей. |
| **Dynamic FPS** | `dynamic-fps` | OK | Режет FPS в фоне. |
| **Cull Leaves** | `cull-leaves` | OK | Culling листвы. |
| Sodium Extra | `sodium-extra` | OK | Опции поверх Sodium. |
| Reese's Sodium Options | `reeses-sodium-options` | OK | Удобное меню опций Sodium. |
| Embeddium | `embeddium` | OK | Альтернатива Sodium; **не совмещать** с Sodium. |
| Spark | `spark` | OK | Профилировщик (скорее для отладки, не для всех игроков). |

## Красивые экраны загрузки / меню

| Мод | Slug | Статус | Заметки |
|-----|------|--------|---------|
| **FancyMenu** | `fancymenu` | OK | Кастомные меню, кнопки, анимации. |
| **Konkrete** | `konkrete` | OK | Зависимость FancyMenu / Drippy. |
| **Drippy Loading Screen** | `drippy-loading-screen` | OK | Кастомный loading screen (часто в паре с FancyMenu). |
| Seamless Loading Screen | `seamless-loading-screen` | OK | Плавный мир→мир без «дёрганого» экрана. |
| Dark Loading Screen (Neo) | `dark-loading-screen-neoforge` | needs verification | Есть в поиске; сверьте актуальный файл под 1.21.1. |

## Connected textures / обновление текстур без полного reload

| Мод | Slug | Статус | Заметки |
|-----|------|--------|---------|
| **Fusion (Connected Textures)** | `fusion-connected-textures` | OK | Нативный NeoForge CTM — предпочтительнее Continuity на NF. |
| **Athena** | `athena-ctm` | OK | CTM/библиотека для ресурс-паков. |
| Continuity | `continuity` | OK jar, ⚠️ deps | Есть `3.0.0+1.21.neoforge`, но официально опирается на **Connector + Forgified Fabric API**. Для «чистого» NF лучше Fusion. |
| Hot-Reload Resource Packs | `hot-reload-resource-packs` | OK | Перезагрузка ресурс-паков без полного выхода; не «seamless CTM», но близко к задаче. |

## QoL / «кул столы» модпака

| Мод | Slug | Статус | Заметки |
|-----|------|--------|---------|
| Jade | `jade` | OK | Подсказки по блокам/сущностям (HWYLA). |
| AppleSkin | `appleskin` | OK | Голод/насыщение на еде. |
| Cloth Config | `cloth-config` | OK | Часто зависимость конфиг-UI. |
| Controlling + Searchables | `controlling`, `searchables` | OK | Поиск по кейбиндам. |
| Mouse Tweaks / Inventory Essentials | `inventory-essentials` | OK | Удобный инвентарь. |
| JEI / EMI | `jei`, `emi` | OK | Рецепты; обычно берут **один**. |
| Xaero's Minimap / World Map | `xaeros-minimap`, `xaeros-world-map` | OK | Карты. |
| No Chat Reports | `no-chat-reports` | OK | Отключает chat reporting. |
| Sound Physics Remastered | `sound-physics-remastered` | OK | Объёмный звук. |
| Distant Horizons | `distanthorizons` | OK | LOD дальних чанков. **Конфликт с Voxy.** Лаунчер запускает Java 21+ с ZGC (без `-XX:+DisableExplicitGC`), чтобы DH не ругался на G1/ExplicitGC. |
| Voxy | `voxy` | needs verification на NeoForge | На Modrinth для 1.21.1 помечен как **Fabric**; на NF — только через Connector или сторонний порт. Не включать вместе с DH. |
| Better Clouds | `better-clouds` | ⚠️ partial macOS OpenGL 4.1 | Красивые облака. **Не** использует Transform Feedback. На macOS GL 4.1 мод сам включает fallbacks (`base_instance`, `stencil_texture`) и пишет «GPU not fully compatible». Chat-warn глушится `gpuIncompatibleMessageEnabled=false`. После отключения GPU accel у AsyncParticles BC можно пробовать вручную. |
| AsyncParticles | `asyncparticles` | ⚠️ GPU accel unsafe macOS AMD | Ускорение частиц. Опция `rendering.gpuAcceleration` включает Transform Feedback → на Hackintosh AMD OpenGL 4.1 native Abort (`glEndTransformFeedback` / `gpusKillClientExt`). Лаунчер на macOS принудительно ставит `gpuAcceleration=false` при запуске. Остальной мод (async tick/culling) можно оставить. |

## Чего избегать / проверять отдельно

- **Sodium + Embeddium** — взаимоисключающие.
- **Distant Horizons + Voxy** — лаунчер уже предупреждает.
- **AsyncParticles `gpuAcceleration` на macOS / Hackintosh AMD** — **unsafe**: единственный известный источник `glEndTransformFeedback` Abort в сборке. Не путать с Better Clouds (у BC TF нет). Лаунчер патчит конфиг; не включай GPU accel вручную.
- **Better Clouds на macOS OpenGL 4.1** — **partial**: fallbacks есть (как на Apple Silicon, [#24](https://github.com/Qendolin/better-clouds/issues/24)), полной гарантии на AMD-драйвере macOS нет. После фикса AsyncParticles можно включить в UI (`mod-choices`). Конфиг: `useFallbacks=true`.
- **Continuity на «чистом» NeoForge** — без Connector могут быть сюрпризы; Fusion проще.
- **Starlight** — для 1.21.x обычно не нужен (лайтинг ванили уже другой); на Modrinth NF 1.21.1 нет.
- Серверные моды (`servercore`, `chunky`) — не для optional client-списка лаунчера.

## Как добавить в админке

1. Скачать jar с Modrinth (loader NeoForge, MC 1.21.1).
2. Загрузить в активную сборку как `kind=mod`, `side=client`, `optional=true`.
3. Задать `modId` (slug или neoForge modid), `displayName`, `description`, `enabledByDefault`.
4. Для конфликтующих пар при желании проставить в манифесте `conflictsWith: ["otherModId"]` (поле в protocol уже есть; UI лаунчера также знает DH↔Voxy статически).
