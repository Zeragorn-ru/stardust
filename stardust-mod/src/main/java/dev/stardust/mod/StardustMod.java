package dev.stardust.mod;

import net.neoforged.bus.api.IEventBus;
import net.neoforged.fml.ModContainer;
import net.neoforged.fml.common.Mod;
import net.neoforged.fml.loading.FMLEnvironment;
import net.neoforged.neoforge.common.NeoForge;
import net.neoforged.neoforge.event.RegisterCommandsEvent;
import net.neoforged.neoforge.event.ServerChatEvent;
import net.neoforged.neoforge.event.entity.player.PlayerEvent;
import net.neoforged.neoforge.event.server.ServerStartedEvent;
import net.neoforged.neoforge.event.tick.ServerTickEvent;
import net.minecraft.commands.CommandSourceStack;
import net.minecraft.commands.arguments.EntityArgument;
import com.mojang.brigadier.arguments.StringArgumentType;
import net.minecraft.commands.Commands;
import net.minecraft.ChatFormatting;
import net.minecraft.network.chat.Component;
import net.minecraft.network.chat.MutableComponent;
import net.minecraft.server.level.ServerPlayer;
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

        if (FMLEnvironment.dist.isClient()) {
            StardustCrashReporter.installClientHooks();
            NeoForge.EVENT_BUS.addListener(StardustCrashReporter::onGameShuttingDown);
            NeoForge.EVENT_BUS.addListener(StardustCrashReporter::onClientLoggingIn);
            NeoForge.EVENT_BUS.addListener(StardustCrashReporter::onClientLoggingOut);
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
                .then(Commands.argument("target", EntityArgument.player())
                        .then(Commands.argument("message", StringArgumentType.greedyString())
                                .executes(ctx -> sendPrivateMessage(ctx.getSource(),
                                        EntityArgument.getPlayer(ctx, "target"),
                                        StringArgumentType.getString(ctx, "message"))))));
    }

    private int sendPrivateMessage(CommandSourceStack source, ServerPlayer target, String text) {
        if (!(source.getEntity() instanceof ServerPlayer sender)) return 0;
        Component senderName = StardustChatNotifications.parseFormattedString(
                StardustTabIntegration.resolveBadgeForName(sender.getGameProfile().getName())
                        + StardustTabIntegration.resolveNameForChat(sender.getGameProfile().getName()));
        Component targetName = StardustChatNotifications.parseFormattedString(
                StardustTabIntegration.resolveBadgeForName(target.getGameProfile().getName())
                        + StardustTabIntegration.resolveNameForChat(target.getGameProfile().getName()));
        MutableComponent toTarget = Component.empty()
                .append(Component.literal("✦ ЛС от ").withStyle(ChatFormatting.DARK_AQUA))
                .append(senderName)
                .append(Component.literal(": ").withStyle(ChatFormatting.GRAY))
                .append(Component.literal(text).withStyle(ChatFormatting.WHITE));
        MutableComponent toSender = Component.empty()
                .append(Component.literal("✦ ЛС для ").withStyle(ChatFormatting.DARK_AQUA))
                .append(targetName)
                .append(Component.literal(": ").withStyle(ChatFormatting.GRAY))
                .append(Component.literal(text).withStyle(ChatFormatting.WHITE));
        target.sendSystemMessage(toTarget);
        sender.sendSystemMessage(toSender);
        return 1;
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
        String name = player.getGameProfile().getName();
        String badge = StardustTabIntegration.resolveBadgeForName(name);
        String coloredName = StardustTabIntegration.resolveNameForChat(name);
        Component styled = StardustChatNotifications.parseFormattedString(badge + coloredName);

        MutableComponent chatMessage = Component.empty()
                .append(Component.literal("[").withStyle(ChatFormatting.GRAY))
                .append(styled != null && !styled.getString().isEmpty() ? styled : Component.literal(name))
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
            double mspt = (telemetryTickNanos / (double) telemetryTickCount) / 1_000_000.0;
            double tps = Math.min(20.0, 1_000_000_000.0 / Math.max(1, telemetryTickIntervalNanos / telemetryTickCount));
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
