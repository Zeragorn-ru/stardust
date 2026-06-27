package dev.stardust.mod;

import me.neznamy.tab.api.TabAPI;
import me.neznamy.tab.api.TabPlayer;
import me.neznamy.tab.api.event.EventBus;
import me.neznamy.tab.api.event.player.PlayerLoadEvent;
import me.neznamy.tab.api.event.plugin.TabLoadEvent;
import me.neznamy.tab.api.tablist.TabListFormatManager;
import net.neoforged.fml.loading.FMLPaths;

import java.nio.file.Path;

/**
 * Интеграция Stardust с плагином/модом TAB (NEZNAMY/TAB).
 *
 * <p>TAB присутствует в среде выполнения как отдельный мод и предоставляет
 * классы {@code me.neznamy.tab.api.*}. Здесь они используются только для
 * компиляции ({@code compileOnly}); во время выполнения они приходят от TAB.
 * Поэтому весь код, ссылающийся на эти классы, изолирован в этом классе и
 * вызывается лениво — если TAB не установлен, мод просто молча не активирует
 * интеграцию.</p>
 *
 * <p>На событии загрузки игрока ({@link PlayerLoadEvent}) выставляем:</p>
 * <ul>
 *   <li>tabprefix — бейдж игрока ({@link TabListFormatManager#setPrefix});</li>
 *   <li>customtabname — цветной ник ({@link TabListFormatManager#setName}).</li>
 * </ul>
 */
final class StardustTabIntegration {

    private StardustTabIntegration() {
    }

    /**
     * Пытается подключиться к TAB. Безопасно для вызова, даже если TAB
     * отсутствует: {@link NoClassDefFoundError} ловится и логируется как info.
     */
    static void tryBootstrap() {
        try {
            Path configDir = FMLPaths.CONFIGDIR.get();
            register(configDir);
        } catch (LinkageError e) {
            // TAB не установлен на сервере — это нормальный сценарий.
            // LinkageError покрывает NoClassDefFoundError (отсутствие классов TAB).
            StardustMod.LOGGER.info("Stardust: TAB не найден, интеграция таба отключена.");
        } catch (RuntimeException e) {
            StardustMod.LOGGER.warn("Stardust: не удалось инициализировать интеграцию с TAB", e);
        }
    }

    private static void register(Path configDir) {
        TabAPI api = TabAPI.getInstance();
        if (api == null) {
            StardustMod.LOGGER.info("Stardust: TabAPI ещё не готов, интеграция таба пропущена.");
            return;
        }
        EventBus eventBus = api.getEventBus();
        if (eventBus == null) {
            StardustMod.LOGGER.warn("Stardust: TAB event bus недоступен.");
            return;
        }

        // Конфиг перечитываем при каждой (пере)загрузке TAB, чтобы /tab reload
        // подхватывал изменения бейджей без рестарта сервера.
        final BadgeHolder holder = new BadgeHolder(configDir);
        holder.reload();

        eventBus.register(TabLoadEvent.class, event -> holder.reload());
        eventBus.register(PlayerLoadEvent.class, event -> applyBadge(api, holder.current(), event.getPlayer()));

        StardustMod.LOGGER.info("Stardust: интеграция с TAB активирована (бейджей в конфиге: {}).",
                holder.current().size());
    }

    private static void applyBadge(TabAPI api, StardustBadgeConfig config, TabPlayer player) {
        if (player == null || config.isEmpty()) {
            return;
        }
        StardustBadgeConfig.Assignment assignment = config.lookup(player.getName());
        if (assignment == null) {
            return;
        }
        TabListFormatManager formatManager = api.getTabListFormatManager();
        if (formatManager == null) {
            return;
        }
        try {
            if (assignment.badge() != null && !assignment.badge().isEmpty()) {
                formatManager.setPrefix(player, assignment.badge());
            }
            if (assignment.nameColor() != null && !assignment.nameColor().isEmpty()) {
                // Цветной ник = цвет + сам ник игрока.
                formatManager.setName(player, assignment.nameColor() + player.getName());
            }
        } catch (RuntimeException e) {
            StardustMod.LOGGER.warn("Stardust: не удалось применить бейдж игроку {}", player.getName(), e);
        }
    }

    /** Держит актуальный снимок конфига между перезагрузками TAB. */
    private static final class BadgeHolder {
        private final Path configDir;
        private volatile StardustBadgeConfig config;

        BadgeHolder(Path configDir) {
            this.configDir = configDir;
            this.config = StardustBadgeConfig.load(configDir);
        }

        void reload() {
            this.config = StardustBadgeConfig.load(configDir);
        }

        StardustBadgeConfig current() {
            return config;
        }
    }
}