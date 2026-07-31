package dev.stardust.mod;

import net.minecraft.core.BlockPos;
import net.minecraft.world.InteractionResult;
import net.minecraft.world.entity.player.Player;
import net.minecraft.world.entity.item.ItemEntity;
import net.minecraft.world.item.ItemStack;
import net.minecraft.core.component.DataComponents;
import net.minecraft.world.item.component.BlockItemStateProperties;
import net.minecraft.world.level.Level;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.LightBlock;
import net.minecraft.world.level.block.state.BlockState;
import net.neoforged.neoforge.event.entity.player.PlayerInteractEvent;
import net.neoforged.neoforge.event.level.BlockDropsEvent;

/** Enables the vanilla light block's creative-only interaction in survival. */
public final class StardustLightBlockInteraction {
    private StardustLightBlockInteraction() {}

    public static void onRightClickBlock(PlayerInteractEvent.RightClickBlock event) {
        Player player = event.getEntity();
        ItemStack stack = event.getItemStack();
        if (player.isSpectator() || stack.getItem() != Blocks.LIGHT.asItem()) return;

        Level level = event.getLevel();
        BlockPos clickedPos = event.getPos();
        BlockState clickedState = level.getBlockState(clickedPos);

        if (clickedState.is(Blocks.LIGHT)) {
            if (!level.isClientSide) {
                int current = clickedState.getValue(LightBlock.LEVEL);
                int next = player.isShiftKeyDown() ? (current == 0 ? 15 : current - 1) : (current + 1) % 16;
                level.setBlock(clickedPos, clickedState.setValue(LightBlock.LEVEL, next), 3);
            }
            event.setCanceled(true);
            event.setCancellationResult(InteractionResult.sidedSuccess(level.isClientSide));
            return;
        }

        BlockPos placementPos = clickedState.canBeReplaced()
                ? clickedPos
                : clickedPos.relative(event.getFace());
        BlockState placementState = level.getBlockState(placementPos);
        if (!placementState.canBeReplaced() || !player.mayBuild()) return;

        if (!level.isClientSide) {
            level.setBlock(placementPos, getState(stack), 3);
            if (!player.getAbilities().instabuild) stack.shrink(1);
        }
        event.setCanceled(true);
        event.setCancellationResult(InteractionResult.sidedSuccess(level.isClientSide));
    }

    public static void onRightClickItem(PlayerInteractEvent.RightClickItem event) {
        ItemStack stack = event.getItemStack();
        if (stack.getItem() != Blocks.LIGHT.asItem()) return;

        int current = getState(stack).getValue(LightBlock.LEVEL);
        int next = event.getEntity().isShiftKeyDown()
                ? (current == 0 ? 15 : current - 1)
                : (current + 1) % 16;
        LightBlock.setLightOnStack(stack, next);
        event.setCanceled(true);
        event.setCancellationResult(InteractionResult.sidedSuccess(event.getEntity().level().isClientSide));
    }

    public static void onLightBlockDrops(BlockDropsEvent event) {
        if (!event.getState().is(Blocks.LIGHT)) return;

        ItemStack drop = new ItemStack(Blocks.LIGHT);
        LightBlock.setLightOnStack(drop, event.getState().getValue(LightBlock.LEVEL));
        BlockPos pos = event.getPos();
        ServerLevel level = event.getLevel();
        event.getDrops().add(new ItemEntity(
                level,
                pos.getX() + 0.5,
                pos.getY() + 0.5,
                pos.getZ() + 0.5,
                drop));
    }

    private static BlockState getState(ItemStack stack) {
        BlockState state = Blocks.LIGHT.defaultBlockState();
        BlockItemStateProperties properties = stack.get(DataComponents.BLOCK_STATE);
        return properties == null ? state : properties.apply(state);
    }

}
