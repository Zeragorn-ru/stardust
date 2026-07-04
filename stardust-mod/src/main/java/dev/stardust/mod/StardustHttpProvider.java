package dev.stardust.mod;

import com.google.gson.Gson;
import com.google.gson.reflect.TypeToken;

import java.io.IOException;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.Collections;
import java.util.Locale;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;

/**
 * HTTP-провайдер кастомизации ника для серверного мода Stardust.
 *
 * <p>Периодически запрашивает {@code GET /api/server/customization?players=...}
 * у auth-server и кеширует результат. Используется интеграцией с TAB для
 * выставления бейджа (tab-префикс) и цветного градиента ника.</p>
 *
 * <p>Конфигурация (в {@code server.properties} или через env):
 * <ul>
 *   <li>{@code stardust.auth-url} — базовый URL auth-server (без слэша на конце)</li>
 *   <li>{@code stardust.refresh-interval-seconds} — интервал обновления (по умолчанию 60)</li>
 * </ul>
 */
public final class StardustHttpProvider {

    private static final Gson GSON = new Gson();
    private static final Duration HTTP_TIMEOUT = Duration.ofSeconds(10);

    /** Данные кастомизации для одного игрока. */
    public record Assignment(String badge, String badgeColor, String nameColor,
                             String gradientStart, String gradientEnd) {
    }

    private final String authUrl;
    private final HttpClient httpClient;
    private final ScheduledExecutorService scheduler;
    private final Map<String, Assignment> cache = new ConcurrentHashMap<>();
    private volatile boolean running = false;

    public StardustHttpProvider(String authUrl, int refreshIntervalSeconds) {
        this.authUrl = authUrl.endsWith("/") ? authUrl.substring(0, authUrl.length() - 1) : authUrl;
        this.httpClient = HttpClient.newBuilder()
                .connectTimeout(HTTP_TIMEOUT)
                .build();
        this.scheduler = Executors.newSingleThreadScheduledExecutor(r -> {
            Thread t = new Thread(r, "stardust-http-provider");
            t.setDaemon(true);
            return t;
        });
    }

    /**
     * Запускает фоновое обновление кеша.
     * Вызывается при старте сервера (или при загрузке TAB).
     */
    public void start() {
        if (running) return;
        running = true;
        // Первый запрос — сразу, затем с интервалом.
        scheduler.scheduleAtFixedRate(this::refresh, 0, 60, TimeUnit.SECONDS);
        StardustMod.LOGGER.info("Stardust HTTP provider запущен (url={})", authUrl);
    }

    /** Останавливает фоновое обновление. */
    public void stop() {
        running = false;
        scheduler.shutdownNow();
    }

    /** Возвращает назначение для ника без учёта регистра, либо {@code null}. */
    public Assignment lookup(String playerName) {
        if (playerName == null) return null;
        return cache.get(playerName.toLowerCase(Locale.ROOT));
    }

    public boolean isEmpty() {
        return cache.isEmpty();
    }

    public int size() {
        return cache.size();
    }

    /** Обновляет кеш, запрашивая данные у auth-server. */
    private void refresh() {
        try {
            // Запрашиваем всех игроков, для которых есть кеш, или пустой список.
            // auth-server вернёт пустую карту если.players не передан.
            String url = authUrl + "/api/server/customization";
            HttpRequest request = HttpRequest.newBuilder()
                    .uri(URI.create(url))
                    .timeout(HTTP_TIMEOUT)
                    .GET()
                    .build();

            HttpResponse<String> response = httpClient.send(request, HttpResponse.BodyHandlers.ofString());
            if (response.statusCode() != 200) {
                StardustMod.LOGGER.warn("Stardust HTTP provider: auth-server вернул {}", response.statusCode());
                return;
            }

            Map<String, ServerResponse> raw = GSON.fromJson(
                    response.body(),
                    new TypeToken<Map<String, ServerResponse>>() {}.getType()
            );

            cache.clear();
            if (raw != null) {
                for (Map.Entry<String, ServerResponse> entry : raw.entrySet()) {
                    String name = entry.getKey();
                    ServerResponse sr = entry.getValue();
                    cache.put(name.toLowerCase(Locale.ROOT), new Assignment(
                            sr.badge,
                            sr.badge_color,
                            sr.name_color,
                            sr.gradient_start,
                            sr.gradient_end
                    ));
                }
            }
            StardustMod.LOGGER.debug("Stardust HTTP provider: обновлено {} записей", cache.size());
        } catch (IOException | InterruptedException e) {
            StardustMod.LOGGER.warn("Stardust HTTP provider: ошибка обновления ({})", e.toString());
        } catch (Exception e) {
            StardustMod.LOGGER.warn("Stardust HTTP provider: неожиданная ошибка", e);
        }
    }

    /** Внутренний DTO для десериализации ответа auth-server. */
    private static class ServerResponse {
        String badge;
        String badge_color;
        String name_color;
        String gradient_start;
        String gradient_end;
    }
}
