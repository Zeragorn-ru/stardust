package dev.stardust.mod;

import me.neznamy.tab.api.TabAPI;
import me.neznamy.tab.api.TabPlayer;
import me.neznamy.tab.api.event.EventBus;
import me.neznamy.tab.api.event.player.PlayerLoadEvent;
import me.neznamy.tab.api.event.plugin.TabLoadEvent;
import me.neznamy.tab.api.tablist.TabListFormatManager;
import net.neoforged.fml.loading.FMLPaths;

/**
 * Интеграция Stardust с плагином/модом TAB (NEZNAMY/TAB).
 *
 * <p>TAB присутствует в среде выполнения как отдельный мод и предоставляет
 * классы {@code me.neznamy.tab.api.*}. Здесь они используются только для
 * компиляции ({@code compileOnly}); во время выполнения они приходят от TAB.</p>
 *
 * <p>На событии загрузки игрока ({@link PlayerLoadEvent}) выставляем:</p>
 * <ul>
 *   <li>tabprefix — бейдж игрока ({@link TabListFormatManager#setPrefix});</li>
 *   <li>customtabname — цветной ник с градиентом ({@link TabListFormatManager#setName}).</li>
 * </ul>
 *
 * <p>Данные кастомизации берутся из {@link StardustHttpProvider}, который
 * периодически опрачивает auth-server. Если auth-сервер недоступен —
 * используется fallback на локальный {@code config/stardust-badges.properties}.</p>
 */
final class StardustTabIntegration {

    private static boolean bootstrapped = false;

    private StardustTabIntegration() {
    }

    /**
     * Пытается подключиться к TAB. Безопасно для вызова, даже если TAB
     * отсутствует: {@link NoClassDefFoundError} ловится и логируется как info.
     */
    static synchronized void tryBootstrap() {
        if (bootstrapped) return;
        try {
            var configDir = FMLPaths.CONFIGDIR.get();
            register(configDir);
        } catch (LinkageError e) {
            StardustMod.LOGGER.info("Stardust: TAB не найден, интеграция таба отключена.");
        } catch (IllegalStateException e) {
            if (String.valueOf(e.getMessage()).contains("API instance is null")) {
                StardustMod.LOGGER.info("Stardust: TAB API ещё не готов, интеграция таба пропущена.");
            } else {
                StardustMod.LOGGER.warn("Stardust: не удалось инициализировать интеграцию с TAB", e);
            }
        } catch (RuntimeException e) {
            StardustMod.LOGGER.warn("Stardust: не удалось инициализировать интеграцию с TAB", e);
        }
    }

    private static void register(java.nio.file.Path configDir) {
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

        // HTTP-провайдер: опрачивает auth-server за кастомизацией.
        // URL берём из системных свойств / server.properties / env.
        String authUrl = System.getProperty("stardust.auth-url",
                System.getenv().getOrDefault("STARDUST_AUTH_URL", "http://localhost:8080"));
        int refreshSecs = Integer.parseInt(
                System.getProperty("stardust.refresh-interval-seconds", "60"));

        StardustHttpProvider httpProvider = new StardustHttpProvider(authUrl, refreshSecs);
        httpProvider.start();

        // Fallback: локальный .properties файл на случай, если auth-server недоступен.
        StardustBadgeConfig localFallback = StardustBadgeConfig.load(configDir);

        eventBus.register(TabLoadEvent.class, event -> {
            // При перезагрузке TAB ничего специального не делаем —
            // httpProvider продолжает работать в фоне.
        });

        eventBus.register(PlayerLoadEvent.class, event ->
                applyBadge(api, httpProvider, localFallback, event.getPlayer()));

        StardustMod.LOGGER.info("Stardust: интеграция с TAB активирована (auth-url={})", authUrl);
        bootstrapped = true;
    }

    private static void applyBadge(TabAPI api, StardustHttpProvider http,
                                   StardustBadgeConfig localFallback, TabPlayer player) {
        if (player == null) return;

        String name = player.getName();
        StardustHttpProvider.Assignment httpAssignment = http.lookup(name);
        StardustBadgeConfig.Assignment localAssignment = (httpAssignment == null || http.isEmpty())
                ? localFallback.lookup(name)
                : null;

        TabListFormatManager fmt = api.getTabListFormatManager();
        if (fmt == null) return;

        try {
            // ─── Бейдж (tab-prefix) ───
            String badge = httpAssignment != null ? httpAssignment.badge()
                    : localAssignment != null ? localAssignment.badge()
                    : null;
            if (badge != null && !badge.isEmpty()) {
                fmt.setPrefix(player, badge);
            }

            // ─── Цветной ник (custom-tab-name) ───
            String coloredName = buildColoredName(name, httpAssignment, localAssignment);
            if (coloredName != null) {
                fmt.setName(player, coloredName);
            }
        } catch (RuntimeException e) {
            StardustMod.LOGGER.warn("Stardust: не удалось применить бейдж игроку {}", name, e);
        }
    }

    /**
     * Собирает строку цветного ника для TAB.
     *
     * <p>Pриоритет: HTTP-провайдер > локальный fallback. Если задан градиент
     * (gradientStart + gradientEnd), формируем hex-строку вида
     * {@code &#RRGGBBnick&#RRGGBB} для TAB v5.5+ с поддержкой hex-цветов.
     * Если только nameColor — используем legacy-код ({@code &b}, {@code &e} и т.д.).
     * Если ничего не задано — возвращаем {@code null} (стандартный ник).</p>
     */
    private static String buildColoredName(String playerName,
                                           StardustHttpProvider.Assignment http,
                                           StardustBadgeConfig.Assignment local) {
        // Градиент из HTTP
        if (http != null && http.gradientStart() != null && http.gradientEnd() != null
                && !http.gradientStart().isEmpty() && !http.gradientEnd().isEmpty()) {
            return formatGradient(playerName, http.gradientStart(), http.gradientEnd());
        }

        // name_color из HTTP
        if (http != null && http.nameColor() != null && !http.nameColor().isEmpty()) {
            return http.nameColor() + playerName;
        }

        // Локальный fallback
        if (local != null && local.nameColor() != null && !local.nameColor().isEmpty()) {
            return local.nameColor() + playerName;
        }

        return null;
    }

    /**
     * Форматирует градиент для TAB v5.5+.
     *
     * <p>TAB поддерживает hex-цвета в формате {@code &#RRGGBB} или
     * {@code &#xAARRGGBB}. Для градиента ника используем два цвета:
     * {@code &#RRGGBB_текст} — но TAB не поддерживает inline-градиент в одном
     * имени напрямую. Вместо этого используем цвет начала градиента как основной
     * цвет ника (это 가장接近 решение).</p>
     *
     * <p>Если TAB v5.5+ поддерживает {@code <gradient>}, используем его:
     * {@code <gradient:#START:#END>name}</p>
     */
    private static String formatGradient(String playerName, String start, String end) {
        String s = normalizeHex(start);
        String e = normalizeHex(end);

        // Пытаемся использовать формат gradient TAB v5.5+
        // формат: <gradient:startcolor:endcolor>text
        return String.format("<gradient:%s:%s>%s</gradient>", s, e, playerName);
    }

    /** Нормализует hex-цвет: убирает `#`, добавляет `#` если нужно. */
    private static String normalizeHex(String color) {
        if (color == null) return "#ffffff";
        String c = color.trim();
        if (c.startsWith("#")) return c;
        if (c.startsWith("&")) {
            // Legacy-код → заглушка, TAB сам разберётся
            return c;
        }
        return "#" + c;
    }
}
