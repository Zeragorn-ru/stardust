package dev.stardust.mod.mixin;

import dev.stardust.mod.StardustLightBlockInteraction;
import net.minecraft.core.BlockPos;
import net.minecraft.world.entity.player.Player;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.level.Level;
import net.minecraft.world.level.block.Block;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.entity.BlockEntity;
import net.minecraft.world.level.block.state.BlockState;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

@Mixin(Block.class)
public abstract class BlockMixin {
    // playerDestroy вызывается после успешного удаления блока с подходящим
    // инструментом; общий spawnAfterBreak вызывается также при взрывах.
    @Inject(method = "playerDestroy", at = @At("TAIL"))
    private void stardust$dropLight(Level level, Player player, BlockPos pos, BlockState state,
                                    BlockEntity blockEntity, ItemStack tool, CallbackInfo ci) {
        if (state.is(Blocks.LIGHT) && !player.preventsBlockDrops()) {
            StardustLightBlockInteraction.onLightBlockDrops(level, pos, state);
        }
    }
}
