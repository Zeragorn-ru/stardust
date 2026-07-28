package dev.stardust.mod;

import net.neoforged.fml.loading.FMLPaths;
import net.neoforged.neoforge.client.event.ClientPlayerNetworkEvent;
import net.neoforged.neoforge.event.GameShuttingDownEvent;

import java.io.IOException;
import java.io.PrintWriter;
import java.io.StringWriter;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Instant;

/** Writes a small local marker that the launcher can attach to crash reports. */
final class StardustCrashReporter {
    private static final Path MARKER = FMLPaths.GAMEDIR.get().resolve("stardust-crash-marker.json");
    private static volatile boolean installed;
    private static Thread.UncaughtExceptionHandler previousHandler;

    private StardustCrashReporter() {}

    static synchronized void installClientHooks() {
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
    }

    static void onGameShuttingDown(GameShuttingDownEvent event) {
        writeMarker("normal", "game_shutting_down", Thread.currentThread().getName(), null);
    }

    static void onClientLoggingIn(ClientPlayerNetworkEvent.LoggingIn event) {
        writeMarker("running", "server_login", Thread.currentThread().getName(), null);
    }

    static void onClientLoggingOut(ClientPlayerNetworkEvent.LoggingOut event) {
        writeMarker("normal", "server_logout", Thread.currentThread().getName(), null);
    }

    private static void writeMarker(String status, String reason, String thread, Throwable error) {
        try {
            Files.createDirectories(MARKER.getParent());
            Files.writeString(MARKER, toJson(status, reason, thread, error), StandardCharsets.UTF_8);
        } catch (IOException e) {
            StardustMod.LOGGER.warn("Failed to write Stardust crash marker", e);
        }
    }

    private static String toJson(String status, String reason, String thread, Throwable error) {
        long pid = ProcessHandle.current().pid();
        StringBuilder json = new StringBuilder(512);
        json.append("{\n");
        appendField(json, "timestamp", Instant.now().toString(), true);
        appendField(json, "pid", Long.toString(pid), false);
        json.append(",\n");
        appendField(json, "status", status, true);
        appendField(json, "reason", reason, true);
        appendField(json, "thread", thread, true);
        if (error != null) {
            appendField(json, "errorClass", error.getClass().getName(), true);
            appendField(json, "message", String.valueOf(error.getMessage()), true);
            appendField(json, "stackTrace", stackTrace(error), true);
        }
        json.append("  \"mod\": \"stardust\"\n");
        json.append("}\n");
        return json.toString();
    }

    private static void appendField(StringBuilder json, String key, String value, boolean quoteValue) {
        json.append("  \"").append(escape(key)).append("\": ");
        if (quoteValue) {
            json.append("\"").append(escape(value)).append("\"");
        } else {
            json.append(value);
        }
        json.append(",\n");
    }

    private static String stackTrace(Throwable error) {
        StringWriter out = new StringWriter();
        error.printStackTrace(new PrintWriter(out));
        return out.toString();
    }

    private static String escape(String value) {
        StringBuilder escaped = new StringBuilder(value.length() + 16);
        for (int i = 0; i < value.length(); i++) {
            char c = value.charAt(i);
            switch (c) {
                case '\\' -> escaped.append("\\\\");
                case '"' -> escaped.append("\\\"");
                case '\n' -> escaped.append("\\n");
                case '\r' -> escaped.append("\\r");
                case '\t' -> escaped.append("\\t");
                default -> {
                    if (c < 0x20) {
                        escaped.append(String.format("\\u%04x", (int) c));
                    } else {
                        escaped.append(c);
                    }
                }
            }
        }
        return escaped.toString();
    }
}
