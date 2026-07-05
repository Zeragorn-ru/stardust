package dev.stardust.mod;

import me.neznamy.tab.api.TabAPI;
import me.neznamy.tab.api.TabPlayer;
import me.neznamy.tab.api.event.EventBus;
import me.neznamy.tab.api.event.plugin.TabLoadEvent;
import me.neznamy.tab.api.event.player.PlayerLoadEvent;
import me.neznamy.tab.api.placeholder.PlaceholderManager;
import me.neznamy.tab.api.placeholder.PlayerPlaceholder;
import net.neoforged.fml.loading.FMLPaths;

final class StardustTabIntegration {

    private static volatile boolean eventBusRegistered = false;
    private static volatile boolean playerListenerRegistered = false;
    private static volatile StardustHttpProvider httpProvider;
    private static volatile StardustBadgeConfig localFallback;
    private static volatile PlayerPlaceholder badgePlaceholder;
    private static volatile PlayerPlaceholder namePlaceholder;
    private static volatile String authUrl;
    private static volatile int refreshSecs;
    private static volatile boolean debug;

    private StardustTabIntegration() {
    }

    static synchronized void refreshNow() {
        StardustHttpProvider http = httpProvider;
        if (http == null) {
            StardustMod.LOGGER.warn("Stardust: HTTP-провайдер не инициализирован.");
            return;
        }
        http.refreshNow();
        registerPlaceholders();
        updateAllPlayers();
        StardustMod.LOGGER.info("Stardust: кеш обновлён, плейсхолдеры перерегистрированы.");
    }

    static synchronized void tryBootstrap() {
        try {
            var configDir = FMLPaths.CONFIGDIR.get();
            StardustServerConfig config = StardustServerConfig.load(configDir);
            authUrl = config.authUrl();
            refreshSecs = config.refreshIntervalSeconds();
            debug = config.debug();

            httpProvider = new StardustHttpProvider(authUrl, refreshSecs, debug);
            httpProvider.setOnlinePlayersProvider(() -> {
                TabAPI a = TabAPI.getInstance();
                if (a == null) return java.util.List.of();
                TabPlayer[] players = a.getOnlinePlayers();
                java.util.List<String> names = new java.util.ArrayList<>(players.length);
                for (TabPlayer p : players) {
                    if (p != null && p.getName() != null) names.add(p.getName());
                }
                return names;
            });
            httpProvider.start();

            localFallback = StardustBadgeConfig.load(configDir);
            registerTabLoadListener();

        } catch (LinkageError e) {
            StardustMod.LOGGER.info("Stardust: TAB не найден, интеграция отключена.");
        } catch (IllegalStateException e) {
            if (String.valueOf(e.getMessage()).contains("API instance is null")) {
                StardustMod.LOGGER.info("Stardust: TAB API ещё не готов.");
            } else {
                StardustMod.LOGGER.warn("Stardust: ошибка интеграции TAB", e);
            }
        } catch (RuntimeException e) {
            StardustMod.LOGGER.warn("Stardust: ошибка интеграции TAB", e);
        }
    }

    private static void registerTabLoadListener() {
        TabAPI api = TabAPI.getInstance();
        if (api == null) return;
        EventBus eventBus = api.getEventBus();
        if (eventBus == null) return;

        if (!eventBusRegistered) {
            eventBus.register(TabLoadEvent.class, event -> {
                StardustMod.LOGGER.info("Stardust TAB: TabLoadEvent → перерегистрация");
                registerPlaceholders();
                // TAB Disabled — откладываем update на 3 сек
                java.util.concurrent.CompletableFuture.delayedExecutor(
                    3, java.util.concurrent.TimeUnit.SECONDS
                ).execute(() -> {
                    StardustMod.LOGGER.info("Stardust TAB: отложенный update #1");
                    updateAllPlayers();
                });
                // Повторный update через 6 сек на случай если TAB медленно стартует
                java.util.concurrent.CompletableFuture.delayedExecutor(
                    6, java.util.concurrent.TimeUnit.SECONDS
                ).execute(() -> {
                    StardustMod.LOGGER.info("Stardust TAB: отложенный update #2");
                    updateAllPlayers();
                });
            });
            eventBusRegistered = true;
        }

        registerPlaceholders();
    }

    private static synchronized void registerPlaceholders() {
        TabAPI api = TabAPI.getInstance();
        if (api == null) {
            StardustMod.LOGGER.warn("Stardust TAB: TabAPI null");
            return;
        }

        PlaceholderManager pm = api.getPlaceholderManager();
        if (pm == null) {
            StardustMod.LOGGER.warn("Stardust TAB: PlaceholderManager null");
            return;
        }

        EventBus eventBus = api.getEventBus();

        // Удаляем старые если есть
        try { pm.unregisterPlaceholder("%stardust_badge%"); } catch (Exception ignored) {}
        try { pm.unregisterPlaceholder("%stardust_name%"); } catch (Exception ignored) {}

        badgePlaceholder = null;
        namePlaceholder = null;

        try {
            badgePlaceholder = pm.registerPlayerPlaceholder(
                    "%stardust_badge%",
                    1000,
                    player -> resolveBadge(httpProvider, localFallback, player)
            );
            StardustMod.LOGGER.info("Stardust TAB: %stardust_badge% registered");
        } catch (Exception e) {
            StardustMod.LOGGER.error("Stardust TAB: register %stardust_badge% failed", e);
            return;
        }

        try {
            namePlaceholder = pm.registerPlayerPlaceholder(
                    "%stardust_name%",
                    1000,
                    player -> resolveName(httpProvider, localFallback, player)
            );
            StardustMod.LOGGER.info("Stardust TAB: %stardust_name% registered");
        } catch (Exception e) {
            StardustMod.LOGGER.error("Stardust TAB: register %stardust_name% failed", e);
            return;
        }

        // PlayerLoadEvent — один раз, читает актуальные ссылки из static полей
        if (!playerListenerRegistered) {
            eventBus.register(PlayerLoadEvent.class, event -> {
                TabPlayer player = event.getPlayer();
                if (player == null) return;
                PlayerPlaceholder bp = badgePlaceholder;
                PlayerPlaceholder np = namePlaceholder;
                try {
                    if (bp != null) bp.update(player);
                    if (np != null) np.update(player);
                } catch (Exception e) {
                    StardustMod.LOGGER.warn("Stardust TAB: update {} failed: {}", player.getName(), e.toString());
                }
            });
            playerListenerRegistered = true;
        }

        StardustMod.LOGGER.info("Stardust TAB: registered (url={}, refresh={}s)", authUrl, refreshSecs);
    }

    private static void updateAllPlayers() {
        TabAPI api = TabAPI.getInstance();
        if (api == null) return;
        PlaceholderManager pm = api.getPlaceholderManager();
        if (pm == null) return;

        // Проверяем живы ли плейсхолдеры — TAB мог убить их при reload
        boolean needReregister = badgePlaceholder == null || namePlaceholder == null;
        if (!needReregister) {
            try {
                var b = pm.getPlaceholder("%stardust_badge%");
                var n = pm.getPlaceholder("%stardust_name%");
                needReregister = (b == null || n == null);
            } catch (Exception e) {
                needReregister = true;
            }
        }
        if (needReregister) {
            StardustMod.LOGGER.info("Stardust: плейсхолдеры потеряны, перерегистрация...");
            registerPlaceholders();
        }

        int count = 0;
        for (TabPlayer p : api.getOnlinePlayers()) {
            if (p == null) continue;
            PlayerPlaceholder bp = badgePlaceholder;
            PlayerPlaceholder np = namePlaceholder;
            try {
                if (bp != null) bp.update(p);
                if (np != null) np.update(p);
                count++;
            } catch (Exception e) {
                StardustMod.LOGGER.warn("Stardust: update {} failed: {}", p.getName(), e.toString());
            }
        }
        StardustMod.LOGGER.info("Stardust: обновлено {} игроков", count);
    }

    // ─────────── Badge ───────────

    static StardustHttpProvider getHttpProvider() {
        return httpProvider;
    }

    static StardustBadgeConfig getLocalFallback() {
        return localFallback;
    }

    /** Форматирует бейдж для имени игрока (для чат-уведомлений). */
    static String resolveBadgeForName(String playerName) {
        StardustHttpProvider http = httpProvider;
        StardustBadgeConfig local = localFallback;
        if (http == null) return "";

        StardustHttpProvider.Assignment h = http.lookup(playerName);
        StardustBadgeConfig.Assignment l = (h == null || http.isEmpty()) ? local.lookup(playerName) : null;

        String badge = h != null ? h.badge() : l != null ? l.badge() : null;
        if (badge == null || badge.isBlank()) return "";

        String color = null;
        if (h != null) {
            if (h.badgeColor() != null && !h.badgeColor().isEmpty()) {
                color = h.badgeColor();
            } else if (h.gradientStart() != null && !h.gradientStart().isEmpty()) {
                color = h.gradientStart();
            }
        }
        if (color == null && l != null && l.nameColor() != null && !l.nameColor().isEmpty()) {
            color = l.nameColor();
        }

        String stripped = stripVS16(badge);
        if (color != null) {
            return wrapHex(stripped, color) + "&r ";
        }
        return stripped + " ";
    }

    /** Форматирует имя игрока для чат-уведомлений (цвет или градиент). */
    static String resolveNameForChat(String playerName) {
        StardustHttpProvider http = httpProvider;
        StardustBadgeConfig local = localFallback;
        if (http == null) return playerName;

        StardustHttpProvider.Assignment h = http.lookup(playerName);
        StardustBadgeConfig.Assignment l = (h == null || http.isEmpty()) ? local.lookup(playerName) : null;

        if (h != null && h.gradientStart() != null && !h.gradientStart().isEmpty()
                && h.gradientEnd() != null && !h.gradientEnd().isEmpty()) {
            return applyHexGradient(playerName, h.gradientStart(), h.gradientEnd());
        } else if (h != null && h.nameColor() != null && !h.nameColor().isEmpty()) {
            return wrapWithColor(playerName, h.nameColor());
        } else if (l != null && l.nameColor() != null && !l.nameColor().isEmpty()) {
            return wrapWithColor(playerName, l.nameColor());
        }
        return playerName;
    }

    private static String resolveBadge(StardustHttpProvider http,
                                       StardustBadgeConfig local,
                                       TabPlayer player) {
        if (player == null) return "";
        String name = player.getName();
        StardustHttpProvider.Assignment h = http.lookup(name);
        StardustBadgeConfig.Assignment l = (h == null || http.isEmpty()) ? local.lookup(name) : null;

        String badge = h != null ? h.badge() : l != null ? l.badge() : null;
        if (badge == null || badge.isBlank()) {
            if (debug) StardustMod.LOGGER.info("Stardust badge('{}') = <empty> (raw={})", name, badge);
            return "";
        }

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
            result = wrapHex(badge, colorStart);
        } else {
            result = stripVS16(badge);
        }
        if (debug) StardustMod.LOGGER.info("Stardust badge('{}') = [{}] len={}", name, result, result.length());
        return result + "&r ";
    }

    // ─────────── Name ───────────

    private static String resolveName(StardustHttpProvider http,
                                      StardustBadgeConfig local,
                                      TabPlayer player) {
        if (player == null) return "";
        String name = player.getName();
        StardustHttpProvider.Assignment h = http.lookup(name);
        StardustBadgeConfig.Assignment l = (h == null || http.isEmpty()) ? local.lookup(name) : null;

        String result;

        if (h != null && h.gradientStart() != null && !h.gradientStart().isEmpty()
                && h.gradientEnd() != null && !h.gradientEnd().isEmpty()) {
            result = applyHexGradient(name, h.gradientStart(), h.gradientEnd());
        } else if (h != null && h.nameColor() != null && !h.nameColor().isEmpty()) {
            result = wrapWithColor(name, h.nameColor());
        } else if (l != null && l.nameColor() != null && !l.nameColor().isEmpty()) {
            result = wrapWithColor(name, l.nameColor());
        } else {
            result = name;
        }

        if (debug) StardustMod.LOGGER.info("Stardust name('{}') = [{}] len={}", name, result, result.length());
        return result;
    }

    // ─────────── Gradient engine ───────────

    private static String applyHexGradient(String text, String startHex, String endHex) {
        if (text == null || text.isEmpty()) return "";
        int[] start = parseHex(startHex);
        int[] end = parseHex(endHex);
        if (start == null || end == null) return text;

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

    private static String wrapHex(String text, String hex) {
        String h = normalizeHex(hex);
        return "&" + h + stripVS16(text);
    }

    /**
     * Убирает Variation Selector 16 (U+FE0F) из строки.
     * Minecraft не понимает VS16 и отображает его как видимый символ "□".
     */
    private static String stripVS16(String s) {
        if (s == null) return null;
        return s.replace("\uFE0F", "");
    }

    private static String wrapWithColor(String text, String color) {
        if (color == null || color.isEmpty()) return text;
        String c = color.trim();
        if (c.startsWith("#")) {
            return "&#" + c.substring(1) + text;
        }
        if (c.startsWith("&#")) {
            return c + text;
        }
        if (c.startsWith("<#") && c.endsWith(">")) {
            return "&#" + c.substring(2, c.length() - 1) + text;
        }
        if (c.startsWith("&") && c.length() == 2) {
            return c + text;
        }
        if (c.length() == 6 && c.chars().allMatch(ch -> "0123456789aAbBcCdDeEfF".indexOf(ch) >= 0)) {
            return "&#" + c + text;
        }
        return c + text;
    }

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

    private static String normalizeHex(String color) {
        if (color == null) return "#ffffff";
        String c = color.trim();
        if (c.startsWith("&#")) c = c.substring(2);
        else if (c.startsWith("#")) c = c.substring(1);
        if (c.length() != 6) return "#ffffff";
        return "#" + c;
    }
}
