package dev.stardust.mod;

import net.minecraft.core.BlockPos;
import net.minecraft.core.component.DataComponents;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.world.InteractionResult;
import net.minecraft.world.entity.item.ItemEntity;
import net.minecraft.world.entity.player.Player;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.item.component.BlockItemStateProperties;
import net.minecraft.world.level.Level;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.LightBlock;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.phys.BlockHitResult;

/** Enables the vanilla light block's creative-only interaction in survival.
 *  Fabric-переписывание StardustLightBlockInteraction (NeoForge): логика
 *  идентична, события другие (UseBlockCallback/UseItemCallback и
 *  LightBlockMixin для дропов — см. mixin). */
public final class StardustLightBlockInteraction {
    private StardustLightBlockInteraction() {}

    /** Fabric UseBlockCallback: true = отменить vanilla-обработку. */
    public static InteractionResult onRightClickBlock(Player player, Level level, ItemStack stack, BlockHitResult hit) {
        if (player.isSpectator() || stack.getItem() != Blocks.LIGHT.asItem()) return InteractionResult.PASS;

        BlockPos clickedPos = hit.getBlockPos();
        BlockState clickedState = level.getBlockState(clickedPos);

        if (clickedState.is(Blocks.LIGHT)) {
            // Adventure-режим: прав на изменение чужого блока нет — иначе
            // игроки в adventure крутят уровень света.
            if (!player.mayBuild()) return InteractionResult.PASS;
            if (!level.isClientSide) {
                int current = clickedState.getValue(LightBlock.LEVEL);
                int next = player.isShiftKeyDown() ? (current == 0 ? 15 : current - 1) : (current + 1) % 16;
                level.setBlock(clickedPos, clickedState.setValue(LightBlock.LEVEL, next), 3);
            }
            return InteractionResult.sidedSuccess(level.isClientSide);
        }

        BlockPos placementPos = clickedState.canBeReplaced()
                ? clickedPos
                : clickedPos.relative(hit.getDirection());
        BlockState placementState = level.getBlockState(placementPos);
        if (!placementState.canBeReplaced() || !player.mayBuild()) return InteractionResult.PASS;

        if (!level.isClientSide) {
            level.setBlock(placementPos, getState(stack), 3);
            if (!player.getAbilities().instabuild) stack.shrink(1);
        }
        return InteractionResult.sidedSuccess(level.isClientSide);
    }

    /** Fabric UseItemCallback: InteractionResult.SUCCESS = отменить vanilla. */
    public static InteractionResult onRightClickItem(Player player, ItemStack stack) {
        if (stack.getItem() != Blocks.LIGHT.asItem()) return InteractionResult.PASS;

        int current = getState(stack).getValue(LightBlock.LEVEL);
        int next = player.isShiftKeyDown()
                ? (current == 0 ? 15 : current - 1)
                : (current + 1) % 16;
        if (next == 15) {
            // Level 15 is the vanilla default and is represented by no component.
            stack.remove(DataComponents.BLOCK_STATE);
        } else {
            LightBlock.setLightOnStack(stack, next);
        }
        return InteractionResult.SUCCESS;
    }

    /** Вызывается из LightBlockMixin (spawnAfterBreak) на серверной стороне. */
    public static void onLightBlockDrops(ServerLevel level, BlockPos pos, BlockState state) {
        if (!state.is(Blocks.LIGHT)) return;

        ItemStack drop = new ItemStack(Blocks.LIGHT);
        LightBlock.setLightOnStack(drop, state.getValue(LightBlock.LEVEL));
        level.addFreshEntity(new ItemEntity(
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
