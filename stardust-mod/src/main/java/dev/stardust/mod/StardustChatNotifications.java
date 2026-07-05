package dev.stardust.mod;

import net.minecraft.ChatFormatting;
import net.minecraft.network.chat.MutableComponent;
import net.minecraft.network.chat.Component;
import net.minecraft.network.chat.Style;
import net.minecraft.network.chat.TextColor;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.level.ServerPlayer;

import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Кастомные уведомления о входе/выходе игроков в чате.
 *
 * <p>Формат:
 * <ul>
 *   <li>Вход: {@code [+] Игрок} — зелёный {@code +}, имя с бейджем и покраской</li>
 *   <li>Выход: {@code [-] Игрок} — красный {@code -}, имя с бейджем и покраской</li>
 * </ul>
 */
final class StardustChatNotifications {

    private static final Pattern HEX_PATTERN = Pattern.compile("(&#[0-9a-fA-F]{6})");

    private StardustChatNotifications() {
    }

    static void onPlayerJoin(ServerPlayer player) {
        MinecraftServer server = player.getServer();
        if (server == null) return;

        String name = player.getName().getString();
        String badge = StardustTabIntegration.resolveBadgeForName(name);
        String coloredName = StardustTabIntegration.resolveNameForChat(name);

        MutableComponent message = Component.empty()
                .append(Component.literal("[").withStyle(ChatFormatting.GRAY))
                .append(Component.literal("+").withStyle(ChatFormatting.GREEN))
                .append(Component.literal("] ").withStyle(ChatFormatting.GRAY))
                .append(parseFormattedString(badge + coloredName));

        for (ServerPlayer p : server.getPlayerList().getPlayers()) {
            p.sendSystemMessage(message);
        }
    }

    static void onPlayerQuit(ServerPlayer player) {
        MinecraftServer server = player.getServer();
        if (server == null) return;

        String name = player.getName().getString();
        String badge = StardustTabIntegration.resolveBadgeForName(name);
        String coloredName = StardustTabIntegration.resolveNameForChat(name);

        MutableComponent message = Component.empty()
                .append(Component.literal("[").withStyle(ChatFormatting.GRAY))
                .append(Component.literal("-").withStyle(ChatFormatting.RED))
                .append(Component.literal("] ").withStyle(ChatFormatting.GRAY))
                .append(parseFormattedString(badge + coloredName));

        for (ServerPlayer p : server.getPlayerList().getPlayers()) {
            p.sendSystemMessage(message);
        }
    }

    /**
     * Парсит строку с {@code &#RRGGBB} и legacy цветовыми кодами в {@link Component}.
     */
    static Component parseFormattedString(String formatted) {
        if (formatted == null || formatted.isEmpty()) return Component.empty();

        MutableComponent result = Component.empty();
        StringBuilder currentSegment = new StringBuilder();
        Style currentStyle = Style.EMPTY;

        int length = formatted.length();
        int i = 0;
        while (i < length) {
            char c = formatted.charAt(i);
            if ((c == '&' || c == '§') && i + 1 < length) {
                if (formatted.charAt(i + 1) == '#' && i + 7 < length) {
                    String hex = formatted.substring(i + 2, i + 8);
                    if (isHex(hex)) {
                        flushSegment(result, currentSegment, currentStyle);
                        TextColor color = TextColor.parseColor("#" + hex).result().orElse(null);
                        if (color != null) {
                            currentStyle = Style.EMPTY.withColor(color);
                        }
                        i += 8;
                        continue;
                    }
                }

                char code = Character.toLowerCase(formatted.charAt(i + 1));
                if ("0123456789abcdefklmnor".indexOf(code) >= 0) {
                    flushSegment(result, currentSegment, currentStyle);
                    if (code == 'r') {
                        currentStyle = Style.EMPTY;
                    } else if ((code >= '0' && code <= '9') || (code >= 'a' && code <= 'f')) {
                        ChatFormatting format = ChatFormatting.getByCode(code);
                        if (format != null) {
                            currentStyle = Style.EMPTY.withColor(TextColor.fromLegacyFormat(format));
                        }
                    } else {
                        if (code == 'k') currentStyle = currentStyle.withObfuscated(true);
                        else if (code == 'l') currentStyle = currentStyle.withBold(true);
                        else if (code == 'm') currentStyle = currentStyle.withStrikethrough(true);
                        else if (code == 'n') currentStyle = currentStyle.withUnderlined(true);
                        else if (code == 'o') currentStyle = currentStyle.withItalic(true);
                    }
                    i += 2;
                    continue;
                }
            }

            currentSegment.append(c);
            i++;
        }
        flushSegment(result, currentSegment, currentStyle);

        return result;
    }

    private static void flushSegment(MutableComponent result, StringBuilder segment, Style style) {
        if (segment.length() > 0) {
            result.append(Component.literal(segment.toString()).withStyle(style));
            segment.setLength(0);
        }
    }

    private static boolean isHex(String s) {
        if (s.length() != 6) return false;
        for (int i = 0; i < 6; i++) {
            char c = s.charAt(i);
            if (Character.digit(c, 16) == -1) {
                return false;
            }
        }
        return true;
    }
}
