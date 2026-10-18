package dev.stardust.mod.mixin;

import net.minecraft.core.BlockPos;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.world.item.Items;
import net.minecraft.world.level.block.LightBlock;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.phys.shapes.CollisionContext;
import net.minecraft.world.phys.shapes.Shapes;
import net.minecraft.world.phys.shapes.VoxelShape;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfoReturnable;
import dev.stardust.mod.StardustLightBlockInteraction;

/** Makes vanilla light blocks targetable while holding the light item and
 *  adds light-level-preserving drops in survival (NeoForge used BlockDropsEvent,
 *  Fabric — хук в spawnAfterBreak). */
@Mixin(LightBlock.class)
public abstract class LightBlockMixin {
    @Inject(method = "getShape", at = @At("HEAD"), cancellable = true)
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

    /** Vanilla дроп лайт-блока только в creative; в survival это событие
     *  и есть место, где NeoForge-версия добавляла свой ItemEntity. */
    @Inject(method = "spawnAfterBreak", at = @At("HEAD"), cancellable = true)
    private void stardust$dropLightInSurvival(
            ServerLevel level,
            BlockState state,
            BlockPos pos,
            net.minecraft.util.RandomSource random,
            net.minecraft.world.item.ItemStack tool,
            boolean dropExperience,
            CallbackInfo ci) {
        if (state.is(net.minecraft.world.level.block.Blocks.LIGHT)) {
            StardustLightBlockInteraction.onLightBlockDrops(level, pos, state);
            ci.cancel();
        }
    }
}
