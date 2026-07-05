package dev.stardust.mod.mixin;

import net.minecraft.network.chat.Component;
import net.minecraft.network.chat.contents.TranslatableContents;
import net.minecraft.server.players.PlayerList;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

@Mixin(PlayerList.class)
public abstract class PlayerListMixin {

    @Inject(
        method = "broadcastSystemMessage(Lnet/minecraft/network/chat/Component;Z)V",
        at = @At("HEAD"),
        cancellable = true
    )
    private void stardust$suppressVanillaJoinLeave(Component message, boolean bypassHiddenChat, CallbackInfo ci) {
        if (message != null && message.getContents() instanceof TranslatableContents tc) {
            String key = tc.getKey();
            if ("multiplayer.player.joined".equals(key) || "multiplayer.player.left".equals(key)) {
                ci.cancel();
            }
        }
    }
}
