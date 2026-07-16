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
    }

    private void onServerStarted(ServerStartedEvent event) {
        StardustTabIntegration.tryBootstrap();
    }

    private void onCommandsRegister(RegisterCommandsEvent event) {
        event.getDispatcher().register(
            net.minecraft.commands.Commands.literal("stardust")
                .then(net.minecraft.commands.Commands.literal("refresh")
                    .executes(ctx -> {
                        StardustTabIntegration.refreshNow();
                        ctx.getSource().sendSuccess(() -> net.minecraft.network.chat.Component.literal("§aStardust: кеш кастомизации обновлён."), true);
                        return 1;
                    })
                )
        );
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
}
