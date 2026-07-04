package dev.stardust.mod;

import java.io.IOException;
import java.io.Reader;
import java.io.Writer;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Properties;

/** Server-side Stardust config. */
public final class StardustServerConfig {

    private static final String FILE_NAME = "stardust-server.properties";
    private static final String DEFAULT_AUTH_URL = "https://auth.zeragorn.xyz";
    private static final int DEFAULT_REFRESH_SECONDS = 60;

    private final String authUrl;
    private final int refreshIntervalSeconds;

    private StardustServerConfig(String authUrl, int refreshIntervalSeconds) {
        this.authUrl = authUrl;
        this.refreshIntervalSeconds = refreshIntervalSeconds;
    }

    public String authUrl() {
        return authUrl;
    }

    public int refreshIntervalSeconds() {
        return refreshIntervalSeconds;
    }

    public static StardustServerConfig load(Path configDir) {
        Path file = configDir.resolve(FILE_NAME);
        Properties props = new Properties();

        try {
            Files.createDirectories(configDir);
            if (Files.notExists(file)) {
                writeDefault(file);
            }
            try (Reader reader = Files.newBufferedReader(file, StandardCharsets.UTF_8)) {
                props.load(reader);
            }
        } catch (IOException e) {
            StardustMod.LOGGER.warn("Stardust server config: не удалось прочитать {} ({})", file, e.toString());
        }

        String authUrl = firstNonBlank(
                System.getProperty("stardust.auth-url"),
                System.getenv("STARDUST_AUTH_URL"),
                props.getProperty("stardust.auth-url"),
                DEFAULT_AUTH_URL
        );

        int refresh = parseRefreshSeconds(firstNonBlank(
                System.getProperty("stardust.refresh-interval-seconds"),
                System.getenv("STARDUST_REFRESH_INTERVAL_SECONDS"),
                props.getProperty("stardust.refresh-interval-seconds"),
                String.valueOf(DEFAULT_REFRESH_SECONDS)
        ));

        return new StardustServerConfig(authUrl, refresh);
    }

    private static void writeDefault(Path file) throws IOException {
        Properties props = new Properties();
        props.setProperty("stardust.auth-url", DEFAULT_AUTH_URL);
        props.setProperty("stardust.refresh-interval-seconds", String.valueOf(DEFAULT_REFRESH_SECONDS));
        try (Writer writer = Files.newBufferedWriter(file, StandardCharsets.UTF_8)) {
            props.store(writer, "Stardust server config");
        }
        StardustMod.LOGGER.info("Stardust server config: создан {}", file);
    }

    private static String firstNonBlank(String... values) {
        for (String value : values) {
            if (value != null && !value.trim().isEmpty()) {
                return value.trim();
            }
        }
        return DEFAULT_AUTH_URL;
    }

    private static int parseRefreshSeconds(String raw) {
        try {
            return Math.max(10, Integer.parseInt(raw.trim()));
        } catch (Exception e) {
            return DEFAULT_REFRESH_SECONDS;
        }
    }
}
