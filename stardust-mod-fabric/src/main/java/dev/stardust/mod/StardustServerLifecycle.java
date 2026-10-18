package dev.stardust.mod;

import com.mojang.brigadier.CommandDispatcher;
import net.minecraft.commands.CommandSourceStack;
import net.minecraft.commands.arguments.EntityArgument;
import net.minecraft.commands.arguments.MessageArgument;
import net.minecraft.commands.Commands;
import net.minecraft.ChatFormatting;
import net.minecraft.network.chat.ClickEvent;
import net.minecraft.network.chat.Component;
import net.minecraft.network.chat.HoverEvent;
import net.minecraft.network.chat.MutableComponent;
import net.minecraft.network.chat.PlayerChatMessage;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.sounds.SoundEvents;
import net.minecraft.sounds.SoundSource;

import java.util.Collection;

/**
 * Серверная логика мода на Fabric: команды, чат, телеметрия.
 * Перенос из StardustMod (NeoForge) — логика идентична, шина другая.
 */
public final class StardustServerLifecycle {
    private StardustServerLifecycle() {}

    static void onServerStarted(MinecraftServer server) {
        // Новый мир в одиночке = новый MinecraftServer со своим tickCounter
        // (см. комментарий в NeoForge-версии).
        lastTelemetryTick = 0;
        telemetryTickNanos = 0;
        telemetryTickIntervalNanos = 0;
        lastTickNanos = 0;
        telemetryTickCount = 0;
        StardustTabIntegration.tryBootstrap();
    }

    static void registerCommands(CommandDispatcher<CommandSourceStack> dispatcher) {
        dispatcher.register(
            Commands.literal("stardust")
                .then(Commands.literal("refresh")
                    .requires(source -> source.hasPermission(2))
                    .executes(ctx -> {
                        StardustTabIntegration.refreshNow();
                        ctx.getSource().sendSuccess(() -> Component.literal("§aStardust: кеш кастомизации обновлён."), true);
                        return 1;
                    })
                )
                .then(Commands.literal("reload")
                    .requires(source -> source.hasPermission(2))
                    .executes(ctx -> {
                        StardustTabIntegration.reloadConfig();
                        ctx.getSource().sendSuccess(() -> Component.literal("§aStardust: конфиг и telemetry token перечитаны."), true);
                        return 1;
                    })
                )
        );
        registerPrivateMessage(dispatcher, "tell");
        registerPrivateMessage(dispatcher, "w");
        registerPrivateMessage(dispatcher, "msg");
        registerPrivateMessage(dispatcher, "whisper");
    }

    private static void registerPrivateMessage(CommandDispatcher<CommandSourceStack> dispatcher, String literal) {
        dispatcher.register(Commands.literal(literal)
                .requires(source -> source.getEntity() instanceof ServerPlayer)
                .then(Commands.argument("targets", EntityArgument.players())
                        .then(Commands.argument("message", MessageArgument.message())
                                .executes(ctx -> {
                                    Collection<ServerPlayer> targets = EntityArgument.getPlayers(ctx, "targets");
                                    MessageArgument.resolveChatMessage(ctx, "message", message ->
                                            sendPrivateMessages(ctx.getSource(), targets, message));
                                    return targets.size();
                                }))));
    }

    private static void sendPrivateMessages(CommandSourceStack source,
                                     Collection<ServerPlayer> targets,
                                     PlayerChatMessage message) {
        if (!(source.getEntity() instanceof ServerPlayer sender)) return;

        Component senderName = formatPlayerName(sender);
        for (ServerPlayer target : targets) {
            Component targetName = formatPlayerName(target);
            String text = message.signedContent();

            // Два явных system-сообщения, чтобы у отправителя был локальный эхо.
            sender.sendSystemMessage(formatPrivateMessage("▸ ЛС для ", targetName, text));
            if (target != sender) {
                target.sendSystemMessage(formatPrivateMessage("◂ ЛС от ", senderName, text));
                target.playNotifySound(SoundEvents.EXPERIENCE_ORB_PICKUP, SoundSource.PLAYERS, 1.0f, 1.0f);
            }
        }
    }

    /**
     * Обработка чата: true — пропустить vanilla-сообщение (заменяем своим),
     * false — разрешить стандартную отправку.
     */
    static boolean onServerChat(PlayerChatMessage message, ServerPlayer sender) {
        MutableComponent chatMessage = Component.empty()
                .append(Component.literal("[").withStyle(ChatFormatting.GRAY))
                .append(formatPlayerName(sender))
                .append(Component.literal("] ").withStyle(ChatFormatting.GRAY))
                .append(Component.literal(message.signedContent()));

        MinecraftServer server = sender.getServer();
        if (server != null) {
            server.getPlayerList().broadcastSystemMessage(chatMessage, false);
        }
        return false;
    }

    static Component formatPlayerName(ServerPlayer player) {
        String name = player.getGameProfile().getName();
        StardustHttpProvider.Assignment assignment = StardustTabIntegration.resolveAssignmentForName(name);
        ClickEvent click = new ClickEvent(ClickEvent.Action.SUGGEST_COMMAND, "/w " + name + " ");

        MutableComponent result = Component.empty();
        String badgeText = StardustTabIntegration.resolveBadgeForName(name);
        if (!badgeText.isEmpty()) {
            result.append(withPlayerActions(
                    StardustChatNotifications.parseFormattedString(badgeText),
                    click,
                    badgeHover(assignment)));
        }
        result.append(withPlayerActions(
                StardustChatNotifications.parseFormattedString(StardustTabIntegration.resolveNameForChat(name)),
                click,
                nameHover(assignment)));
        return result;
    }

    private static Component withPlayerActions(Component component, ClickEvent click, Component tooltip) {
        return component.copy().withStyle(style -> style
                .withClickEvent(click)
                .withHoverEvent(new HoverEvent(HoverEvent.Action.SHOW_TEXT, tooltip)));
    }

    private static Component badgeHover(StardustHttpProvider.Assignment assignment) {
        String badge = assignment == null || assignment.badge() == null ? "✦" : assignment.badge();
        String label = assignment != null && assignment.badgeLabel() != null && !assignment.badgeLabel().isBlank()
                ? assignment.badgeLabel() : "Бейдж игрока";
        String color = assignment == null ? null : assignment.badgeColor();
        String coloredBadge = colorPrefix(color) + badge + " - " + label;
        String description = assignment != null && assignment.badgeDescription() != null
                && !assignment.badgeDescription().isBlank()
                ? assignment.badgeDescription() : "Персональный бейдж игрока";
        return hoverText(StardustChatNotifications.parseFormattedString(coloredBadge), description);
    }

    private static Component nameHover(StardustHttpProvider.Assignment assignment) {
        Component title;
        String description;
        if (assignment != null && assignment.gradientLabel() != null && !assignment.gradientLabel().isBlank()) {
            title = StardustChatNotifications.parseFormattedString(
                    StardustTabIntegration.formatGradientForChat(
                            assignment.gradientLabel(), assignment.gradientStart(), assignment.gradientEnd()));
            description = assignment.gradientDescription();
        } else {
            title = Component.literal("Цвет ника").withStyle(ChatFormatting.WHITE);
            description = "Цветной ник игрока";
        }
        return hoverText(title, description);
    }

    private static String colorPrefix(String color) {
        if (color == null || color.isBlank()) return "";
        String value = color.trim();
        if (value.startsWith("&#") || (value.startsWith("&") && value.length() == 2)) return value;
        if (value.startsWith("#")) return "&" + value;
        if (value.length() == 6) return "&#" + value;
        return value;
    }

    private static Component hoverText(Component title, String description) {
        String detail = description == null || description.isBlank() ? "Описание отсутствует" : description;
        return Component.empty()
                .append(title)
                .append(Component.literal("\n").withStyle(ChatFormatting.WHITE))
                .append(Component.literal(detail).withStyle(ChatFormatting.WHITE))
                .append(Component.literal("\n").withStyle(ChatFormatting.GRAY))
                .append(Component.literal("Нажмите, чтобы написать в ЛС").withStyle(ChatFormatting.GRAY));
    }

    private static MutableComponent formatPrivateMessage(String prefix, Component playerName, String text) {
        return Component.empty()
                .append(Component.literal(prefix).withStyle(ChatFormatting.AQUA))
                .append(playerName)
                .append(Component.literal("  ").withStyle(ChatFormatting.DARK_GRAY))
                .append(Component.literal(text).withStyle(ChatFormatting.WHITE));
    }

    // ─── Телеметрия (перенос из NeoForge-версии) ─────────────────────────────

    private static long lastTelemetryTick;
    private static long telemetryTickNanos;
    private static long telemetryTickIntervalNanos;
    private static long lastTickNanos;
    private static long telemetryTickCount;

    static void onServerTick(MinecraftServer server) {
        // Телеметрия — только с выделенного сервера: одиночная игра (даже
        // открытая в LAN) — это клиентская машина, её TPS/MSPT не нужны
        // админке.
        if (!server.isDedicatedServer()) return;

        // Try Spark first — it has accurate TPS/MSPT with proper averaging.
        me.lucko.spark.api.Spark spark = null;
        try { spark = me.lucko.spark.api.SparkProvider.get(); } catch (Exception ignored) {}

        long now = System.nanoTime();
        if (lastTickNanos != 0) {
            telemetryTickNanos += now - lastTickNanos;
            telemetryTickIntervalNanos += now - lastTickNanos;
        }
        lastTickNanos = now;
        telemetryTickCount++;
        if (server.getTickCount() - lastTelemetryTick < 300) return;
        lastTelemetryTick = server.getTickCount();
        StardustHttpProvider provider = StardustTabIntegration.getHttpProvider();
        if (provider != null && telemetryTickCount > 1) {
            double mspt;
            double tps;
            if (spark != null && spark.mspt() != null && spark.tps() != null) {
                mspt = spark.mspt().poll(me.lucko.spark.api.statistic.StatisticWindow.MillisPerTick.MINUTES_1).mean();
                tps = spark.tps().poll(me.lucko.spark.api.statistic.StatisticWindow.TicksPerSecond.SECONDS_10);
            } else {
                mspt = (telemetryTickNanos / (double) telemetryTickCount) / 1_000_000.0;
                tps = Math.min(20.0, 1_000_000_000.0 / Math.max(1, telemetryTickIntervalNanos / telemetryTickCount));
            }
            provider.sendTelemetry(
                server.getPlayerList().getPlayers().stream().map(p -> p.getGameProfile().getName()).toList(),
                tps, mspt);
            telemetryTickNanos = 0;
            telemetryTickIntervalNanos = 0;
            telemetryTickCount = 0;
            lastTickNanos = now;
        }
    }
}
