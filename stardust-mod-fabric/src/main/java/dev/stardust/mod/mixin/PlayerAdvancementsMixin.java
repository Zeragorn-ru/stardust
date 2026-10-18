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
 * (NeoForge), поэтому вешаем хук на PlayerAdvancements.grant — в момент,
 * когда прогресс достигает 100% и advancement реально выдан.
 */
@Mixin(net.minecraft.server.PlayerAdvancements.class)
public abstract class PlayerAdvancementsMixin {
    @Shadow
    private ServerPlayer player;

    @Inject(method = "grant", at = @At("TAIL"))
    private void stardust$onAdvancementGranted(AdvancementHolder advancement, String criterion,
            CallbackInfoReturnable<Boolean> cir) {
        // grant возвращает false, если критерий не завершил advancement:
        // реакция только на полную выдачу.
        if (!cir.getReturnValueZ()) return;
        StardustSuperChallengeHealth.onAdvancementEarned(player, advancement.id());
    }
}
