package dev.stardust.mod;

import com.google.gson.Gson;
import com.google.gson.JsonObject;
import net.neoforged.fml.loading.FMLPaths;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.Optional;
import java.util.concurrent.atomic.AtomicBoolean;

/** Sends a crash notification from a NeoForge dedicated server only. */
final class StardustDedicatedServerCrashReporter {
    private static final Gson GSON = new Gson();
    private static final Duration REPORT_TIMEOUT = Duration.ofSeconds(5);
    private static final AtomicBoolean REPORTED = new AtomicBoolean();
    private static boolean installed;

    private StardustDedicatedServerCrashReporter() {}

    static synchronized void install() {
        if (installed) {
            return;
        }
        installed = true;
        Thread.UncaughtExceptionHandler previous = Thread.getDefaultUncaughtExceptionHandler();
        Thread.setDefaultUncaughtExceptionHandler((thread, error) -> {
            report(thread, error);
            if (previous != null) {
                previous.uncaughtException(thread, error);
            }
        });
        StardustMod.LOGGER.info("Stardust dedicated-server crash notifications enabled");
    }

    private static void report(Thread thread, Throwable error) {
        if (!REPORTED.compareAndSet(false, true)) {
            return;
        }

        try {
            StardustServerConfig config = StardustServerConfig.load(FMLPaths.CONFIGDIR.get());
            if (config.serverToken().isBlank()) {
                StardustMod.LOGGER.warn("Stardust server crash report skipped: server token is not configured");
                return;
            }

            JsonObject body = new JsonObject();
            body.addProperty("server", Optional.ofNullable(System.getenv("STARDUST_SERVER_NAME"))
                    .filter(value -> !value.isBlank()).orElse("dedicated-server"));
            body.addProperty("thread", thread.getName());
            body.addProperty("errorClass", error.getClass().getName());
            body.addProperty("message", String.valueOf(error.getMessage()));
            body.addProperty("stackTrace", stackTrace(error));

            HttpRequest request = HttpRequest.newBuilder()
                    .uri(URI.create(config.authUrl().replaceAll("/$", "") + "/api/server/report-crash"))
                    .timeout(REPORT_TIMEOUT)
                    .header("Authorization", "Bearer " + config.serverToken())
                    .header("Content-Type", "application/json")
                    .POST(HttpRequest.BodyPublishers.ofString(GSON.toJson(body)))
                    .build();
            HttpResponse<Void> response = HttpClient.newBuilder()
                    .connectTimeout(REPORT_TIMEOUT)
                    .build()
                    .send(request, HttpResponse.BodyHandlers.discarding());
            if (response.statusCode() / 100 != 2) {
                StardustMod.LOGGER.warn("Stardust server crash report failed: HTTP {}", response.statusCode());
            }
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            StardustMod.LOGGER.warn("Stardust server crash report interrupted", e);
        } catch (Exception e) {
            StardustMod.LOGGER.warn("Stardust server crash report failed", e);
        }
    }

    private static String stackTrace(Throwable error) {
        java.io.StringWriter out = new java.io.StringWriter();
        error.printStackTrace(new java.io.PrintWriter(out));
        return out.toString();
    }
}
