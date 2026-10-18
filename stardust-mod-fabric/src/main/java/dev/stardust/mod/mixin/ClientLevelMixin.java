package dev.stardust.mod.mixin;

import net.minecraft.client.multiplayer.ClientLevel;
import net.minecraft.client.Minecraft;
import net.minecraft.world.item.Items;
import net.minecraft.world.level.block.Block;
import net.minecraft.world.level.block.Blocks;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.Shadow;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfoReturnable;

/** Shows vanilla light-block markers in survival while holding the light item. */
@Mixin(ClientLevel.class)
public abstract class ClientLevelMixin {
    @Shadow
    private Minecraft minecraft;

    @Inject(method = "getMarkerParticleTarget", at = @At("HEAD"), cancellable = true)
    private void stardust$allowLightMarkersInSurvival(CallbackInfoReturnable<Block> cir) {
        if (minecraft.player != null && minecraft.player.getMainHandItem().is(Items.LIGHT)) {
            cir.setReturnValue(Blocks.LIGHT);
        }
    }
}
