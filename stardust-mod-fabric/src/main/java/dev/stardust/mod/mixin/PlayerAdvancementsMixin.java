package dev.stardust.mod.mixin;

import net.minecraft.advancements.AdvancementHolder;
import net.minecraft.server.level.ServerPlayer;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.Shadow;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfoReturnable;
import dev.stardust.mod.StardustSuperChallengeHealth;

/**
 * Трекер выдачи advancement: в Fabric API нет события AdvancementEvent
 * (NeoForge), поэтому вешаем хук на PlayerAdvancements.award — в момент,
 * когда прогресс достигает 100% и advancement реально выдан.
 */
@Mixin(net.minecraft.server.PlayerAdvancements.class)
public abstract class PlayerAdvancementsMixin {
    @Shadow
    private ServerPlayer player;

    @Inject(method = "award", at = @At(value = "INVOKE",
            target = "Lnet/minecraft/advancements/AdvancementRewards;grant(Lnet/minecraft/server/level/ServerPlayer;)V"))
    private void stardust$onAdvancementGranted(AdvancementHolder advancement, String criterion,
            CallbackInfoReturnable<Boolean> cir) {
        // Vanilla выдаёт награду только при переходе от незавершённого прогресса к завершённому.
        StardustSuperChallengeHealth.onAdvancementEarned(player, advancement.id());
    }
}
