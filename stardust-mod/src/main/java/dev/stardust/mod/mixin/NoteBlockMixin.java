package dev.stardust.mod.mixin;

import net.minecraft.core.BlockPos;
import net.minecraft.core.Holder;
import net.minecraft.resources.ResourceLocation;
import net.minecraft.sounds.SoundEvent;
import net.minecraft.sounds.SoundSource;
import net.minecraft.world.level.Level;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.NoteBlock;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.core.particles.ParticleTypes;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.Unique;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfoReturnable;

/** Restores the copper trumpet instruments added after Minecraft 1.21.1. */
@Mixin(NoteBlock.class)
public abstract class NoteBlockMixin {
    @Inject(method = "triggerEvent", at = @At("HEAD"), cancellable = true)
    private void stardust$playCopperTrumpet(
            BlockState state,
            Level level,
            BlockPos pos,
            int eventId,
            int eventData,
            CallbackInfoReturnable<Boolean> cir) {
        if (eventId != 0 || !state.getValue(NoteBlock.INSTRUMENT).isTunable()) return;

        String sound = stardust$copperTrumpetSound(level.getBlockState(pos.below()));
        if (sound == null) return;

        int note = state.getValue(NoteBlock.NOTE);
        level.addParticle(
                ParticleTypes.NOTE,
                pos.getX() + 0.5,
                pos.getY() + 1.2,
                pos.getZ() + 0.5,
                note / 24.0,
                0.0,
                0.0);
        level.playSeededSound(
                null,
                pos.getX() + 0.5,
                pos.getY() + 0.5,
                pos.getZ() + 0.5,
                Holder.direct(SoundEvent.createVariableRangeEvent(
                        ResourceLocation.fromNamespaceAndPath("stardust", sound))),
                SoundSource.RECORDS,
                3.0F,
                NoteBlock.getPitchFromNote(note),
                level.random.nextLong());
        cir.setReturnValue(true);
    }

    @Unique
    private static String stardust$copperTrumpetSound(BlockState state) {
        if (state.is(Blocks.OXIDIZED_COPPER) || state.is(Blocks.WAXED_OXIDIZED_COPPER)) {
            return "trumpet_oxidized";
        }
        if (state.is(Blocks.WEATHERED_COPPER) || state.is(Blocks.WAXED_WEATHERED_COPPER)) {
            return "trumpet_weathered";
        }
        if (state.is(Blocks.EXPOSED_COPPER) || state.is(Blocks.WAXED_EXPOSED_COPPER)) {
            return "trumpet_exposed";
        }
        if (state.is(Blocks.COPPER_BLOCK) || state.is(Blocks.WAXED_COPPER_BLOCK)) {
            return "trumpet";
        }
        return null;
    }
}
