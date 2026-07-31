package dev.stardust.mod.mixin;

import net.minecraft.world.item.Items;
import net.minecraft.world.level.block.Block;
import net.minecraft.world.level.block.LightBlock;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.phys.shapes.CollisionContext;
import net.minecraft.world.phys.shapes.Shapes;
import net.minecraft.world.phys.shapes.VoxelShape;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfoReturnable;

/** Keeps light-block outlines visible while holding the item in survival. */
@Mixin(LightBlock.class)
public abstract class LightBlockMixin {
    @Inject(method = "getShape", at = @At("RETURN"), cancellable = true)
    private void stardust$showHeldLightBlock(
            BlockState state,
            net.minecraft.world.level.BlockGetter level,
            net.minecraft.core.BlockPos pos,
            CollisionContext context,
            CallbackInfoReturnable<VoxelShape> cir) {
        if (context.isHoldingItem(Items.LIGHT)) {
            cir.setReturnValue(Shapes.block());
        }
    }
}
