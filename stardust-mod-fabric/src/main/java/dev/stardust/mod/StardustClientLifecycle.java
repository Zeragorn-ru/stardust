package dev.stardust.mod;

import net.fabricmc.fabric.api.client.event.lifecycle.v1.ClientLifecycleEvents;
import net.fabricmc.fabric.api.client.networking.v1.ClientPlayConnectionEvents;
import net.fabricmc.loader.api.FabricLoader;

import java.io.IOException;
import java.io.PrintWriter;
import java.io.StringWriter;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Instant;

/**
 * Клиентские хуки мода на Fabric: маркер краша, который лаунчер прикладывает
 * к отчётам (перенос StardustCrashReporter с NeoForge).
 */
final class StardustClientLifecycle {
    private static final Path MARKER = FabricLoader.getInstance().getGameDir().resolve("stardust-crash-marker.json");
    private static volatile boolean installed;
    private static Thread.UncaughtExceptionHandler previousHandler;

    private StardustClientLifecycle() {}

    static synchronized void install() {
        if (installed) {
            return;
        }
        installed = true;
        previousHandler = Thread.getDefaultUncaughtExceptionHandler();
        Thread.setDefaultUncaughtExceptionHandler((thread, error) -> {
            writeMarker("crash", "uncaught_exception", thread.getName(), error);
            if (previousHandler != null) {
                previousHandler.uncaughtException(thread, error);
            }
        });
        writeMarker("running", "client_started", Thread.currentThread().getName(), null);

        ClientLifecycleEvents.CLIENT_STOPPING.register(client ->
                writeMarker("normal", "game_shutting_down", Thread.currentThread().getName(), null));
        ClientPlayConnectionEvents.JOIN.register((handler, sender, client) ->
                writeMarker("running", "server_login", Thread.currentThread().getName(), null));
        ClientPlayConnectionEvents.DISCONNECT.register((handler, client) ->
                writeMarker("normal", "server_logout", Thread.currentThread().getName(), null));
    }

    private static void writeMarker(String status, String reason, String thread, Throwable error) {
        try {
            Files.createDirectories(MARKER.getParent());
            Files.writeString(MARKER, toJson(status, reason, thread, error), StandardCharsets.UTF_8);
        } catch (IOException e) {
            StardustFabricMod.LOGGER.warn("Failed to write Stardust crash marker", e);
        }
    }

    private static String toJson(String status, String reason, String thread, Throwable error) {
        long pid = ProcessHandle.current().pid();
        long now = Instant.now().toEpochMilli();
        String stack = "";
        if (error != null) {
            StringWriter sw = new StringWriter();
            error.printStackTrace(new PrintWriter(sw));
            stack = sw.toString().replace("\\", "\\\\").replace("\"", "\\\"").replace("\n", "\\n").replace("\r", "");
        }
        return "{\"status\":\"" + status + "\",\"reason\":\"" + reason + "\",\"thread\":\"" + thread
                + "\",\"pid\":" + pid + ",\"time\":" + now + ",\"error\":\"" + stack + "\"}";
    }
}
