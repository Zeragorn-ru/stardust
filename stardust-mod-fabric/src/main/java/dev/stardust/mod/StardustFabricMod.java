package dev.stardust.mod;

import net.fabricmc.api.ModInitializer;
import net.fabricmc.fabric.api.command.v2.CommandRegistrationCallback;
import net.fabricmc.fabric.api.entity.event.v1.ServerPlayerEvents;
import net.fabricmc.fabric.api.event.lifecycle.v1.ServerLifecycleEvents;
import net.fabricmc.fabric.api.event.lifecycle.v1.ServerTickEvents;
import net.fabricmc.fabric.api.event.player.UseBlockCallback;
import net.fabricmc.fabric.api.event.player.UseItemCallback;
import net.fabricmc.fabric.api.message.v1.ServerMessageEvents;
import net.fabricmc.fabric.api.networking.v1.ServerPlayConnectionEvents;
import net.fabricmc.loader.api.FabricLoader;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * Entrypoint мода Stardust на Fabric (параллельная версия stardust-mod на
 * NeoForge — код логики общий, разница только в шине событий).
 *
 * <p>Серверная часть интегрируется с плагином TAB (если он установлен), чтобы
 * выставлять игрокам бейдж (tab-префикс) и цветной ник в табе.</p>
 *
 * <p>Advancement-события в Fabric API нет (в NeoForge — AdvancementEvent):
 * выдача трекается через PlayerAdvancementTrackerMixin.</p>
 */
public final class StardustFabricMod implements ModInitializer {
    public static final String MOD_ID = "stardust";
    public static final Logger LOGGER = LoggerFactory.getLogger("Stardust");

    @Override
    public void onInitialize() {
        LOGGER.info("Stardust shared mod initialized (fabric, env={})",
            FabricLoader.getInstance().getEnvironmentType());

        ServerLifecycleEvents.SERVER_STARTED.register(StardustServerLifecycle::onServerStarted);
        ServerTickEvents.END_SERVER_TICK.register(StardustServerLifecycle::onServerTick);
        // Чат: false = не отправлять vanilla-сообщение (заменяем своим форматом).
        ServerMessageEvents.ALLOW_CHAT_MESSAGE.register((message, sender, params) ->
                StardustServerLifecycle.onServerChat(message, sender));
        CommandRegistrationCallback.EVENT.register((dispatcher, registryAccess, environment) ->
                StardustServerLifecycle.registerCommands(dispatcher));

        // Вход/выход игроков: уведомления чата + пересчёт супер-челленджей.
        ServerPlayConnectionEvents.JOIN.register((handler, sender, server) -> {
            StardustSuperChallengeHealth.onPlayerLogin(handler.getPlayer());
            StardustChatNotifications.onPlayerJoin(handler.getPlayer());
        });
        ServerPlayConnectionEvents.DISCONNECT.register((handler, server) -> {
            StardustChatNotifications.onPlayerQuit(handler.getPlayer());
            // Кэш супер-челленджей не течёт между сессиями.
            StardustSuperChallengeHealth.forgetPlayer(handler.getPlayer().getUUID());
        });

        // Респавн после смерти (аналог PlayerEvent.Clone): счётчик HP-бонуса.
        ServerPlayerEvents.AFTER_RESPAWN.register((oldPlayer, newPlayer, alive) ->
                StardustSuperChallengeHealth.onPlayerRespawn(newPlayer));

        // Лайт-блок в survival: правый клик по блоку/предмету.
        UseBlockCallback.EVENT.register((player, world, hand, hitResult) ->
                StardustLightBlockInteraction.onRightClickBlock(
                        player,
                        world,
                        player.getItemInHand(hand),
                        hitResult));
        UseItemCallback.EVENT.register((player, world, hand) -> {
            var result = StardustLightBlockInteraction.onRightClickItem(
                    player,
                    player.getItemInHand(hand));
            return new net.minecraft.world.InteractionResultHolder<>(result, player.getItemInHand(hand));
        });

        if (FabricLoader.getInstance().getEnvironmentType() == net.fabricmc.api.EnvType.CLIENT) {
            StardustClientLifecycle.install();
        } else {
            // Dedicated-сервер: уведомления о крашах в бекенд.
            StardustDedicatedServerCrashReporter.install();
        }
    }
}
