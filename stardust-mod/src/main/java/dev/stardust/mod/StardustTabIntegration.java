package dev.stardust.mod;

import me.neznamy.tab.api.TabAPI;
import me.neznamy.tab.api.TabPlayer;
import me.neznamy.tab.api.event.EventBus;
import me.neznamy.tab.api.event.player.PlayerLoadEvent;
import me.neznamy.tab.api.event.plugin.TabLoadEvent;
import me.neznamy.tab.api.placeholder.PlaceholderManager;
import me.neznamy.tab.api.placeholder.PlayerPlaceholder;
import net.neoforged.fml.loading.FMLPaths;

/**
 * Интеграция Stardust с TAB (NEZNAMY/TAB).
 *
 * <p>Регистрирует плейсхолдеры:
 * <ul>
 *   <li>{@code %stardust_badge%} — бейдж с hex-градиентом</li>
 *   <li>{@code %stardust_name%} — ник с hex-градиентом</li>
 * </ul>
 *
 * <p>Конфиг TAB ({@code groups.yml}):
 * <pre>
 * _DEFAULT_:
 *   tabprefix: "%stardust_badge%"
 *   customtabname: "%stardust_name%"
 * </pre>
 *
 * <p>Конфиг TAB ({@code config.yml}):
 * <pre>
 * tablist-name-formatting:
 *   enabled: true
 * </pre>
 */
final class StardustTabIntegration {

    private static boolean bootstrapped = false;

    private StardustTabIntegration() {
    }

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

        PlaceholderManager pm = api.getPlaceholderManager();
        if (pm == null) {
            StardustMod.LOGGER.warn("Stardust: TAB PlaceholderManager недоступен.");
            return;
        }

        StardustServerConfig config = StardustServerConfig.load(configDir);
        String authUrl = config.authUrl();
        int refreshSecs = config.refreshIntervalSeconds();

        StardustHttpProvider httpProvider = new StardustHttpProvider(authUrl, refreshSecs);
        httpProvider.start();

        StardustBadgeConfig localFallback = StardustBadgeConfig.load(configDir);

        // %stardust_badge% — бейдж с hex-градиентом
        PlayerPlaceholder badgePlaceholder = pm.registerPlayerPlaceholder(
                "%stardust_badge%",
                refreshSecs * 1000,
                player -> resolveBadge(httpProvider, localFallback, player)
        );

        // %stardust_name% — ник с hex-градиентом
        PlayerPlaceholder namePlaceholder = pm.registerPlayerPlaceholder(
                "%stardust_name%",
                refreshSecs * 1000,
                player -> resolveName(httpProvider, localFallback, player)
        );

        StardustMod.LOGGER.info("Stardust TAB: плейсхолдеры зарегистрированы");

        eventBus.register(PlayerLoadEvent.class, event -> {
            TabPlayer player = event.getPlayer();
            if (player == null) return;
            try {
                badgePlaceholder.update(player);
                namePlaceholder.update(player);
            } catch (Exception e) {
                StardustMod.LOGGER.warn("Stardust TAB: ошибка обновления плейсхолдеров для {}", player.getName(), e);
            }
        });

        eventBus.register(TabLoadEvent.class, event ->
                StardustMod.LOGGER.info("Stardust TAB: TAB перезагружен"));

        StardustMod.LOGGER.info("Stardust: интеграция с TAB активирована (auth-url={})", authUrl);
        bootstrapped = true;
    }

    // ─────────── Badge ───────────

    private static String resolveBadge(StardustHttpProvider http,
                                       StardustBadgeConfig local,
                                       TabPlayer player) {
        if (player == null) return "";
        String name = player.getName();
        StardustHttpProvider.Assignment h = http.lookup(name);
        StardustBadgeConfig.Assignment l = (h == null || http.isEmpty()) ? local.lookup(name) : null;

        String badge = h != null ? h.badge() : l != null ? l.badge() : null;
        if (badge == null || badge.isEmpty()) return "";

        // Бейдж раскрашиваем градиентом из badgeColor/gradientStart..gradientEnd
        String colorStart = null;
        String colorEnd = null;
        if (h != null) {
            if (h.badgeColor() != null && !h.badgeColor().isEmpty()) {
                colorStart = h.badgeColor();
                colorEnd = h.badgeColor();
            } else if (h.gradientStart() != null && !h.gradientStart().isEmpty()
                    && h.gradientEnd() != null && !h.gradientEnd().isEmpty()) {
                colorStart = h.gradientStart();
                colorEnd = h.gradientEnd();
            }
        }
        if (l != null && l.nameColor() != null && !l.nameColor().isEmpty()) {
            if (colorStart == null) {
                colorStart = l.nameColor();
                colorEnd = l.nameColor();
            }
        }

        String result;
        if (colorStart != null && colorEnd != null) {
            result = applyHexGradient(badge, colorStart, colorEnd);
        } else {
            result = badge;
        }
        // Сброс цвета после бейджа, чтобы ник не наследовал
        return result + "&r";
    }

    // ─────────── Name ───────────

    private static String resolveName(StardustHttpProvider http,
                                      StardustBadgeConfig local,
                                      TabPlayer player) {
        if (player == null) return "";
        String name = player.getName();
        StardustHttpProvider.Assignment h = http.lookup(name);
        StardustBadgeConfig.Assignment l = (h == null || http.isEmpty()) ? local.lookup(name) : null;

        // Градиент
        if (h != null && h.gradientStart() != null && !h.gradientStart().isEmpty()
                && h.gradientEnd() != null && !h.gradientEnd().isEmpty()) {
            return applyHexGradient(name, h.gradientStart(), h.gradientEnd());
        }

        //name_color из HTTP
        if (h != null && h.nameColor() != null && !h.nameColor().isEmpty()) {
            return wrapWithColor(name, h.nameColor());
        }

        // Локальный fallback
        if (l != null && l.nameColor() != null && !l.nameColor().isEmpty()) {
            return wrapWithColor(name, l.nameColor());
        }

        return name;
    }

    // ─────────── Gradient engine ───────────

    /**
     * Создаёт hex-градиент посимвольно.
     * Формат: {@code &#RRGGBBсимвол&#RRGGBBсимвол...}
     * Поддерживает эмодзи (surrogate pairs).
     */
    private static String applyHexGradient(String text, String startHex, String endHex) {
        if (text == null || text.isEmpty()) return "";
        int[] start = parseHex(startHex);
        int[] end = parseHex(endHex);
        if (start == null || end == null) return text;

        // Собираем codepoints и их длину в char[]
        int[] codepoints = text.codePoints().toArray();
        int count = codepoints.length;
        if (count == 0) return "";
        if (count == 1) return wrapHex(text, startHex);

        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < count; i++) {
            float ratio = (float) i / (count - 1);
            int r = Math.round(start[0] + (end[0] - start[0]) * ratio);
            int g = Math.round(start[1] + (end[1] - start[1]) * ratio);
            int b = Math.round(start[2] + (end[2] - start[2]) * ratio);
            sb.append("&#");
            sb.append(String.format("%02X%02X%02X", r, g, b));
            sb.appendCodePoint(codepoints[i]);
        }
        return sb.toString();
    }

    /** Оборачивает текст в один hex-цвет: {@code &#RRGGBBтекст} */
    private static String wrapHex(String text, String hex) {
        String h = normalizeHex(hex);
        return h + text;
    }

    /**
     * Оборачивает текст в цвет.
     * Если hex (#RRGGBB) — используем {@code &#RRGGBBтекст}.
     * Если legacy (&a, &b и т.д.) — используем {@code &кодтекст}.
     */
    private static String wrapWithColor(String text, String color) {
        if (color == null || color.isEmpty()) return text;
        String c = color.trim();
        if (c.startsWith("#")) {
            return "&#" + c.substring(1) + text;
        }
        if (c.startsWith("&#")) {
            return c + text;
        }
        if (c.startsWith("&") && c.length() == 2) {
            return c + text;
        }
        // Попытка как hex без #
        if (c.length() == 6 && c.chars().allMatch(ch -> "0123456789aAbBcCdDeEfF".indexOf(ch) >= 0)) {
            return "&#" + c + text;
        }
        return c + text;
    }

    /** Парсит hex-строку в RGB массив [r, g, b]. Принимает #RRGGBB, RRGGBB, &#RRGGBB. */
    private static int[] parseHex(String hex) {
        if (hex == null) return null;
        String h = hex.trim();
        if (h.startsWith("&#")) h = h.substring(2);
        else if (h.startsWith("#")) h = h.substring(1);
        if (h.length() != 6) return null;
        try {
            int r = Integer.parseInt(h.substring(0, 2), 16);
            int g = Integer.parseInt(h.substring(2, 4), 16);
            int b = Integer.parseInt(h.substring(4, 6), 16);
            return new int[]{r, g, b};
        } catch (NumberFormatException e) {
            return null;
        }
    }

    /** Нормализует hex: убирает #, &# и т.д., возвращает #RRGGBB. */
    private static String normalizeHex(String color) {
        if (color == null) return "#ffffff";
        String c = color.trim();
        if (c.startsWith("&#")) c = c.substring(2);
        else if (c.startsWith("#")) c = c.substring(1);
        if (c.length() != 6) return "#ffffff";
        return "#" + c;
    }
}
