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
     * Парсит строку с {@code &#RRGGBB} цветовыми кодами в {@link Component}.
     */
    private static Component parseFormattedString(String formatted) {
        if (formatted == null || formatted.isEmpty()) return Component.empty();

        MutableComponent result = Component.empty();
        Matcher m = HEX_PATTERN.matcher(formatted);
        int lastEnd = 0;

        while (m.find()) {
            if (m.start() > lastEnd) {
                result.append(Component.literal(formatted.substring(lastEnd, m.start())));
            }
            String hex = m.group(1).substring(2);
            TextColor color = TextColor.parseColor("#" + hex).result().orElse(null);
            int segStart = m.end();
            int segEnd = formatted.length();
            Matcher next = HEX_PATTERN.matcher(formatted);
            if (next.find(segStart)) {
                segEnd = next.start();
            }
            String segment = formatted.substring(segStart, segEnd);
            if (color != null) {
                result.append(Component.literal(segment).withStyle(Style.EMPTY.withColor(color)));
            } else {
                result.append(Component.literal(segment));
            }
            lastEnd = segEnd;
        }

        if (lastEnd < formatted.length()) {
            result.append(Component.literal(formatted.substring(lastEnd)));
        }

        return result;
    }
}
