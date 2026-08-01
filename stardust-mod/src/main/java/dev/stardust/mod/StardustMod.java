package dev.stardust.mod;

import net.neoforged.bus.api.IEventBus;
import net.neoforged.fml.ModContainer;
import net.neoforged.fml.common.Mod;
import net.neoforged.fml.loading.FMLEnvironment;
import net.neoforged.api.distmarker.Dist;
import net.neoforged.neoforge.common.NeoForge;
import net.neoforged.neoforge.event.RegisterCommandsEvent;
import net.neoforged.neoforge.event.ServerChatEvent;
import net.neoforged.neoforge.event.entity.player.PlayerEvent;
import net.neoforged.neoforge.event.server.ServerStartedEvent;
import net.neoforged.neoforge.event.tick.ServerTickEvent;
import net.minecraft.commands.CommandSourceStack;
import net.minecraft.commands.arguments.EntityArgument;
import net.minecraft.commands.arguments.MessageArgument;
import net.minecraft.network.chat.PlayerChatMessage;
import net.minecraft.commands.Commands;
import net.minecraft.ChatFormatting;
import net.minecraft.network.chat.Component;
import net.minecraft.network.chat.ClickEvent;
import net.minecraft.network.chat.HoverEvent;
import net.minecraft.network.chat.MutableComponent;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.sounds.SoundEvents;
import net.minecraft.sounds.SoundSource;

import java.util.Collection;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * Общий мод Stardust для NeoForge 1.21.1 (один jar для клиента и сервера).
 *
 * <p>Серверная часть интегрируется с плагином TAB (если он установлен), чтобы
 * выставлять игрокам бейдж (tab-префикс) и цветной ник в табе. Данные о
 * бейджах/цветах сейчас берутся из локального конфига; позже их источником
 * станет backend Stardust.</p>
 */
@Mod(StardustMod.MOD_ID)
public final class StardustMod {
    public static final String MOD_ID = "stardust";
    public static final Logger LOGGER = LoggerFactory.getLogger("Stardust");

    public StardustMod(IEventBus modEventBus, ModContainer modContainer) {
        LOGGER.info("Stardust shared mod initialized (env={})", FMLEnvironment.dist);

        // Регистрируем обработчики всегда — работают и на dedicated, и на integrated сервере.
        NeoForge.EVENT_BUS.addListener(this::onServerStarted);
        NeoForge.EVENT_BUS.addListener(this::onCommandsRegister);
        NeoForge.EVENT_BUS.addListener(StardustSuperChallengeHealth::onAdvancementEarned);
        NeoForge.EVENT_BUS.addListener(StardustSuperChallengeHealth::onPlayerClone);
        NeoForge.EVENT_BUS.addListener(this::onPlayerLoggedIn);
        NeoForge.EVENT_BUS.addListener(this::onPlayerLoggedOut);
        NeoForge.EVENT_BUS.addListener(this::onServerChat);
        NeoForge.EVENT_BUS.addListener(this::onServerTick);
        NeoForge.EVENT_BUS.addListener(StardustLightBlockInteraction::onRightClickBlock);
        NeoForge.EVENT_BUS.addListener(StardustLightBlockInteraction::onRightClickItem);
        NeoForge.EVENT_BUS.addListener(StardustLightBlockInteraction::onLightBlockDrops);

        if (FMLEnvironment.dist.isClient()) {
            StardustCrashReporter.installClientHooks();
            NeoForge.EVENT_BUS.addListener(StardustCrashReporter::onGameShuttingDown);
            NeoForge.EVENT_BUS.addListener(StardustCrashReporter::onClientLoggingIn);
            NeoForge.EVENT_BUS.addListener(StardustCrashReporter::onClientLoggingOut);
        } else if (FMLEnvironment.dist == Dist.DEDICATED_SERVER) {
            StardustDedicatedServerCrashReporter.install();
        }
    }

    private void onServerStarted(ServerStartedEvent event) {
        StardustTabIntegration.tryBootstrap();
    }

    private void onCommandsRegister(RegisterCommandsEvent event) {
        event.getDispatcher().register(
            Commands.literal("stardust")
                .then(Commands.literal("refresh")
                    .executes(ctx -> {
                        StardustTabIntegration.refreshNow();
                        ctx.getSource().sendSuccess(() -> net.minecraft.network.chat.Component.literal("§aStardust: кеш кастомизации обновлён."), true);
                        return 1;
                    })
                )
                .then(Commands.literal("reload")
                    .executes(ctx -> {
                        StardustTabIntegration.reloadConfig();
                        ctx.getSource().sendSuccess(() -> Component.literal("§aStardust: конфиг и telemetry token перечитаны."), true);
                        return 1;
                    })
                )
        );
        registerPrivateMessage(event, "tell");
        registerPrivateMessage(event, "w");
        registerPrivateMessage(event, "msg");
        registerPrivateMessage(event, "whisper");
    }

    private void registerPrivateMessage(RegisterCommandsEvent event, String literal) {
        event.getDispatcher().register(Commands.literal(literal)
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

    private void sendPrivateMessages(CommandSourceStack source,
                                     Collection<ServerPlayer> targets,
                                     PlayerChatMessage message) {
        if (!(source.getEntity() instanceof ServerPlayer sender)) return;

        Component senderName = formatPlayerName(sender);
        for (ServerPlayer target : targets) {
            Component targetName = formatPlayerName(target);
            String text = message.signedContent();

            // Send two explicit system messages so the sender always gets a local echo.
            sender.sendSystemMessage(formatPrivateMessage("▸ ЛС для ", targetName, text));
            if (target != sender) {
                target.sendSystemMessage(formatPrivateMessage("◂ ЛС от ", senderName, text));
                target.playNotifySound(SoundEvents.EXPERIENCE_ORB_PICKUP, SoundSource.PLAYERS, 1.0f, 1.0f);
            }
        }
    }

    private Component formatPlayerName(ServerPlayer player) {
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

    private Component withPlayerActions(Component component, ClickEvent click, Component tooltip) {
        return component.copy().withStyle(style -> style
                .withClickEvent(click)
                .withHoverEvent(new HoverEvent(HoverEvent.Action.SHOW_TEXT, tooltip)));
    }

    private Component badgeHover(StardustHttpProvider.Assignment assignment) {
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

    private Component nameHover(StardustHttpProvider.Assignment assignment) {
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

    private String colorPrefix(String color) {
        if (color == null || color.isBlank()) return "";
        String value = color.trim();
        if (value.startsWith("&#") || (value.startsWith("&") && value.length() == 2)) return value;
        if (value.startsWith("#")) return "&" + value;
        if (value.length() == 6) return "&#" + value;
        return value;
    }

    private Component hoverText(Component title, String description) {
        String detail = description == null || description.isBlank() ? "Описание отсутствует" : description;
        return Component.empty()
                .append(title)
                .append(Component.literal("\n\n" + detail).withStyle(ChatFormatting.WHITE))
                .append(Component.literal("\n(Нажмите, чтобы написать в ЛС)").withStyle(ChatFormatting.GRAY));
    }

    private MutableComponent formatPrivateMessage(String prefix, Component playerName, String text) {
        return Component.empty()
                .append(Component.literal(prefix).withStyle(ChatFormatting.AQUA))
                .append(playerName)
                .append(Component.literal("  ").withStyle(ChatFormatting.DARK_GRAY))
                .append(Component.literal(text).withStyle(ChatFormatting.WHITE));
    }

    private void onPlayerLoggedIn(PlayerEvent.PlayerLoggedInEvent event) {
        if (event.getEntity() instanceof net.minecraft.server.level.ServerPlayer player) {
            StardustSuperChallengeHealth.onPlayerLogin(player);
            StardustChatNotifications.onPlayerJoin(player);
        }
    }

    private void onPlayerLoggedOut(PlayerEvent.PlayerLoggedOutEvent event) {
        if (event.getEntity() instanceof net.minecraft.server.level.ServerPlayer player) {
            StardustChatNotifications.onPlayerQuit(player);
        }
    }

    private void onServerChat(ServerChatEvent event) {
        event.setCanceled(true);

        ServerPlayer player = event.getPlayer();

        MutableComponent chatMessage = Component.empty()
                .append(Component.literal("[").withStyle(ChatFormatting.GRAY))
                .append(formatPlayerName(player))
                .append(Component.literal("] ").withStyle(ChatFormatting.GRAY))
                .append(Component.literal(event.getRawText()));

        var server = player.getServer();
        if (server != null) {
            server.getPlayerList().broadcastSystemMessage(chatMessage, false);
        }
    }

    private long lastTelemetryTick;
    private long telemetryTickNanos;
    private long telemetryTickIntervalNanos;
    private long lastTickNanos;
    private long telemetryTickCount;
    private void onServerTick(ServerTickEvent.Post event) {
        var server = event.getServer();
        if (server == null) return;

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
