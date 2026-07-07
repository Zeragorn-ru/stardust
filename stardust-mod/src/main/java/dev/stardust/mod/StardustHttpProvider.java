package dev.stardust.mod;

import com.google.gson.Gson;
import com.google.gson.reflect.TypeToken;

import java.io.IOException;
import java.net.URI;
import java.net.URLEncoder;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.Collection;
import java.util.HashSet;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import java.util.function.Supplier;

/**
 * HTTP-провайдер кастомизации ника для серверного мода Stardust.
 *
 * <p>Периодически запрашивает {@code GET /api/server/customization?players=...}
 * у auth-server и кеширует результат. Обновляет только онлайн-игроков.</p>
 */
public final class StardustHttpProvider {

    private static final Gson GSON = new Gson();
    private static final Duration HTTP_TIMEOUT = Duration.ofSeconds(10);

    /** Данные кастомизации для одного игрока. */
    public record Assignment(String badge, String badgeColor, String nameColor,
                             String gradientStart, String gradientEnd) {
    }

    private final String authUrl;
    private final int refreshIntervalSeconds;
    private final boolean debug;
    private final HttpClient httpClient;
    private final ScheduledExecutorService scheduler;
    private final Map<String, Assignment> cache = new ConcurrentHashMap<>();
    private final Set<String> knownNames = ConcurrentHashMap.newKeySet();
    private volatile Supplier<Collection<String>> onlinePlayersProvider;
    private volatile Runnable afterRefresh;
    private volatile boolean running = false;

    public StardustHttpProvider(String authUrl, int refreshIntervalSeconds, boolean debug) {
        this.authUrl = authUrl.endsWith("/") ? authUrl.substring(0, authUrl.length() - 1) : authUrl;
        this.refreshIntervalSeconds = Math.max(3, refreshIntervalSeconds);
        this.debug = debug;
        this.httpClient = HttpClient.newBuilder()
                .connectTimeout(HTTP_TIMEOUT)
                .build();
        this.scheduler = Executors.newSingleThreadScheduledExecutor(r -> {
            Thread t = new Thread(r, "stardust-http-provider");
            t.setDaemon(true);
            return t;
        });
    }

    /** Устанавливает провайдер онлайн-игроков (вызывается из TAB интеграции). */
    public void setOnlinePlayersProvider(Supplier<Collection<String>> provider) {
        this.onlinePlayersProvider = provider;
    }

    /** Вызывается после успешного обновления HTTP-кеша. */
    public void setAfterRefresh(Runnable afterRefresh) {
        this.afterRefresh = afterRefresh;
    }

    public void start() {
        if (running) return;
        running = true;
        scheduler.scheduleAtFixedRate(this::refreshOnline, refreshIntervalSeconds, refreshIntervalSeconds, TimeUnit.SECONDS);
        StardustMod.LOGGER.info("Stardust HTTP provider запущен (url={}, refresh={}s, debug={})", authUrl, refreshIntervalSeconds, debug);
    }

    public void stop() {
        running = false;
        scheduler.shutdownNow();
    }

    public Assignment lookup(String playerName) {
        if (playerName == null) return null;
        String key = playerName.toLowerCase(Locale.ROOT);
        knownNames.add(playerName);
        Assignment cached = cache.get(key);
        if (cached != null) return cached;

        // Первый вход: синхронный fetch только этого игрока
        if (debug) StardustMod.LOGGER.info("Stardust lookup: {} → кеш пустой, fetch", playerName);
        fetchPlayers(Set.of(playerName));
        return cache.get(key);
    }

    public boolean isEmpty() {
        return cache.isEmpty();
    }

    /**
     * Принудительно очищает кеш и перезапрашивает данные для всех известных онлайн-игроков.
     * Вызывается командой /stardust refresh.
     */
    public void refreshNow() {
        cache.clear();
        Supplier<Collection<String>> provider = this.onlinePlayersProvider;
        if (provider == null) return;
        Collection<String> online = provider.get();
        if (online == null || online.isEmpty()) return;
        if (fetchPlayers(online)) notifyAfterRefresh();
    }

    /** Обновляет кеш только для онлайн-игроков. */
    private void refreshOnline() {
        Supplier<Collection<String>> provider = this.onlinePlayersProvider;
        if (provider == null) return;
        Collection<String> online = provider.get();
        if (online == null || online.isEmpty()) return;
        if (fetchPlayers(online)) notifyAfterRefresh();
    }

    /** Запрашивает кастомизацию у auth-server. */
    private boolean fetchPlayers(Collection<String> names) {
        if (names.isEmpty()) return false;
        try {
            String players = names.stream()
                    .filter(name -> name != null && !name.isBlank())
                    .map(String::trim)
                    .map(name -> URLEncoder.encode(name, StandardCharsets.UTF_8))
                    .reduce((a, b) -> a + "," + b)
                    .orElse("");
            if (players.isEmpty()) return false;

            String url = authUrl + "/api/server/customization?players=" + players;
            if (debug) StardustMod.LOGGER.info("Stardust HTTP: → {}", url);
            HttpRequest request = HttpRequest.newBuilder()
                    .uri(URI.create(url))
                    .timeout(HTTP_TIMEOUT)
                    .GET()
                    .build();

            HttpResponse<String> response = httpClient.send(request, HttpResponse.BodyHandlers.ofString());
            if (response.statusCode() != 200) {
                StardustMod.LOGGER.warn("Stardust HTTP: auth-server {}", response.statusCode());
                return false;
            }

            Map<String, ServerResponse> raw = GSON.fromJson(
                    response.body(),
                    new TypeToken<Map<String, ServerResponse>>() {}.getType()
            );

            if (raw != null) {
                for (Map.Entry<String, ServerResponse> entry : raw.entrySet()) {
                    String name = entry.getKey();
                    ServerResponse sr = entry.getValue();
                    if (debug) StardustMod.LOGGER.info("Stardust HTTP: {} → badge={}, color={}, gradient={}→{}",
                            name, sr.badge, sr.name_color, sr.gradient_start, sr.gradient_end);
                    cache.put(name.toLowerCase(Locale.ROOT), new Assignment(
                            sr.badge,
                            sr.badge_color,
                            sr.name_color,
                            sr.gradient_start,
                            sr.gradient_end
                    ));
                }
            }
            if (debug) StardustMod.LOGGER.info("Stardust HTTP: обновлено {}, кеш={}", names.size(), cache.size());
            return true;
        } catch (IOException | InterruptedException e) {
            if (e instanceof InterruptedException) Thread.currentThread().interrupt();
            StardustMod.LOGGER.warn("Stardust HTTP: ошибка ({})", e.toString());
        } catch (Exception e) {
            StardustMod.LOGGER.warn("Stardust HTTP: ошибка", e);
        }
        return false;
    }

    private void notifyAfterRefresh() {
        Runnable callback = afterRefresh;
        if (callback == null) return;
        try {
            callback.run();
        } catch (Exception e) {
            StardustMod.LOGGER.warn("Stardust HTTP: after-refresh callback failed", e);
        }
    }

    private static class ServerResponse {
        String badge;
        String badge_color;
        String name_color;
        String gradient_start;
        String gradient_end;
    }
}
