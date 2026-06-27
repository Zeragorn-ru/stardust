package dev.stardust.mod;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.Locale;
import java.util.Map;

/**
 * Локальный источник бейджей/цветов для игроков.
 *
 * <p>Формат файла {@code config/stardust-badges.properties} — простые строки
 * вида:</p>
 *
 * <pre>
 * # никнейм = ПРЕФИКС/БЕЙДЖ | ЦВЕТ_НИКА
 * # цвет — это legacy-код вида &amp;b или hex вида &amp;#55FFFF (поддержка зависит от TAB)
 * Notch = &amp;6[★] | &amp;e
 * Steve = &amp;b[Stardust] | &amp;b
 * </pre>
 *
 * <p>Это временное решение: позже источником данных станет backend Stardust,
 * и этот класс заменится на сетевой провайдер с тем же контрактом
 * {@link #lookup(String)}.</p>
 */
public final class StardustBadgeConfig {

    /** Бейдж (tab-префикс) и цвет ника для одного игрока. */
    public record Assignment(String badge, String nameColor) {
    }

    private final Map<String, Assignment> byName;

    private StardustBadgeConfig(Map<String, Assignment> byName) {
        this.byName = byName;
    }

    /** Возвращает назначение для ника без учёта регистра, либо {@code null}. */
    public Assignment lookup(String playerName) {
        if (playerName == null) {
            return null;
        }
        return byName.get(playerName.toLowerCase(Locale.ROOT));
    }

    public boolean isEmpty() {
        return byName.isEmpty();
    }

    public int size() {
        return byName.size();
    }

    /**
     * Загружает конфиг из {@code config/stardust-badges.properties}.
     * Если файла нет — создаёт пример и возвращает пустой конфиг.
     * Любая ошибка чтения не валит сервер: возвращается пустой конфиг.
     */
    public static StardustBadgeConfig load(Path configDir) {
        Path file = configDir.resolve("stardust-badges.properties");
        Map<String, Assignment> parsed = new LinkedHashMap<>();
        try {
            if (Files.notExists(file)) {
                writeExample(file);
                return new StardustBadgeConfig(Collections.emptyMap());
            }
            for (String raw : Files.readAllLines(file, StandardCharsets.UTF_8)) {
                String line = raw.trim();
                if (line.isEmpty() || line.startsWith("#")) {
                    continue;
                }
                int eq = line.indexOf('=');
                if (eq <= 0) {
                    StardustMod.LOGGER.warn("Stardust badge config: пропущена строка без '=': {}", raw);
                    continue;
                }
                String name = line.substring(0, eq).trim();
                String value = line.substring(eq + 1).trim();
                String badge = value;
                String color = "";
                int bar = value.indexOf('|');
                if (bar >= 0) {
                    badge = value.substring(0, bar).trim();
                    color = value.substring(bar + 1).trim();
                }
                if (!name.isEmpty()) {
                    parsed.put(name.toLowerCase(Locale.ROOT), new Assignment(badge, color));
                }
            }
        } catch (IOException e) {
            StardustMod.LOGGER.warn("Stardust badge config: не удалось прочитать {} ({})", file, e.toString());
            return new StardustBadgeConfig(Collections.emptyMap());
        }
        return new StardustBadgeConfig(Collections.unmodifiableMap(parsed));
    }

    private static void writeExample(Path file) {
        String example = """
                # Stardust: бейджи и цвета ников для интеграции с TAB.
                # Формат: НИК = ПРЕФИКС/БЕЙДЖ | ЦВЕТ_НИКА
                # Цвет — legacy-код (&b) или hex (&#55FFFF), если ваша версия TAB его поддерживает.
                # Пробелы вокруг '=' и '|' игнорируются. Регистр ника не важен.
                #
                # Примеры (закомментированы):
                # Notch = &6[*] | &e
                # Steve = &b[Stardust] | &b
                """;
        try {
            Files.createDirectories(file.getParent());
            Files.writeString(file, example, StandardCharsets.UTF_8);
            StardustMod.LOGGER.info("Stardust badge config: создан пример {}", file);
        } catch (IOException e) {
            StardustMod.LOGGER.warn("Stardust badge config: не удалось создать пример {} ({})", file, e.toString());
        }
    }
}