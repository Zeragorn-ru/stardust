package dev.stardust.mod.mixin;

import net.minecraft.client.multiplayer.chat.ChatListener;
import net.minecraft.network.chat.PlayerChatMessage;
import net.minecraft.client.multiplayer.PlayerInfo;
import net.minecraft.network.chat.ChatType;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

@Mixin(ChatListener.class)
public abstract class ChatListenerMixin {

    @Inject(
        method = "handlePlayerChatMessage",
        at = @At("HEAD"),
        cancellable = true
    )
    private void stardust$suppressLocalEcho(PlayerChatMessage message, PlayerInfo playerInfo, ChatType.Bound bound, CallbackInfo ci) {
        // When we handle chat via ServerChatEvent + broadcastSystemMessage,
        // the vanilla PlayerChatMessage is never sent to clients.
        // However the client still optimistically renders its own message.
        // Cancelling here prevents the <name> echo for the sender.
        // We only cancel if the sender is the local player (the one who just typed).
        var mc = net.minecraft.client.Minecraft.getInstance();
        if (playerInfo != null && mc.player != null && playerInfo.getProfile().getId().equals(mc.player.getUUID())) {
            ci.cancel();
        }
    }
}