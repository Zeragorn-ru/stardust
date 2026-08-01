package dev.stardust.mod.mixin;

import net.minecraft.world.entity.player.Player;
import net.minecraft.world.item.Items;
import net.minecraft.world.level.BlockGetter;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.state.BlockBehaviour;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.core.BlockPos;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfoReturnable;

/** Allows the vanilla light block to be broken outside creative mode. */
@Mixin(BlockBehaviour.class)
public abstract class BlockBehaviourMixin {
    @Inject(method = "getDestroyProgress", at = @At("HEAD"), cancellable = true)
    private void stardust$allowLightBlockBreaking(
            BlockState state,
            Player player,
            BlockGetter level,
            BlockPos pos,
            CallbackInfoReturnable<Float> cir) {
        if (state.is(Blocks.LIGHT) && player.getMainHandItem().is(Items.LIGHT)) {
            cir.setReturnValue(1.0F);
        }
    }
}
