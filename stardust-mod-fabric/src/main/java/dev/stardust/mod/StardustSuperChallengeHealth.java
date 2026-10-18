package dev.stardust.mod;

import net.minecraft.advancements.AdvancementHolder;
import net.minecraft.advancements.AdvancementProgress;
import net.minecraft.resources.ResourceLocation;
import net.minecraft.server.ServerAdvancementManager;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.entity.ai.attributes.AttributeInstance;
import net.minecraft.world.entity.ai.attributes.AttributeModifier;
import net.minecraft.world.entity.ai.attributes.Attributes;

/**
 * Начисление HP за супер-челленджи BACAP.
 *
 * <p>За каждую выполненную ачивку из вкладки "Super Challenges"
 * начисляется +0.5 сердечка (1 HP), максимум 40 HP (20 сердец / 2 строки).</p>
 *
 * <p>При входе игрока подсчитывает количество выполненных супер-челленджей
 * напрямую из advancement data и синхронизирует счётчик + модификатор HP.</p>
 */
public final class StardustSuperChallengeHealth {

    private static final ResourceLocation MODIFIER_ID =
            ResourceLocation.fromNamespaceAndPath("stardust", "super_challenge_bonus");

    private static final int MAX_BONUS_HP = 20;
    private static final int HP_PER_CHALLENGE = 1;
    private static final String ROOT_ID = "blazeandcave:challenges/root";

    private StardustSuperChallengeHealth() {
    }

    /** Fabric: вызывается из AdvancementEvents (StardustFabricMod). */
    public static void onAdvancementEarned(ServerPlayer player, ResourceLocation id) {
        if (!isSuperChallenge(id)) return;

        int newCount = countCompletedChallenges(player);
        setCompletedCount(player, newCount);
        applyHealthBonus(player, newCount);

        StardustFabricMod.LOGGER.info("Stardust SC: {} выполнил '{}' (всего: {}, HP bonus: {})",
                player.getName().getString(), id.getPath(), newCount,
                Math.min(newCount * HP_PER_CHALLENGE, MAX_BONUS_HP));
    }

    /**
     * При входе: пересчитывает выполненные челленджи из advancement data,
     * синхронизирует счётчик и применяет бонус HP.
     */
    public static void onPlayerLogin(ServerPlayer player) {
        int count = countCompletedChallenges(player);
        setCompletedCount(player, count);
        applyHealthBonus(player, count);

        if (count > 0) {
            StardustFabricMod.LOGGER.info("Stardust SC: {} вошёл, супер-челленджей: {}, HP bonus: {}",
                    player.getName().getString(), count,
                    Math.min(count * HP_PER_CHALLENGE, MAX_BONUS_HP));
        }
    }

    /**
     * После смерти Minecraft создаёт новую сущность игрока, поэтому модификатор
     * MAX_HEALTH нужно заново повесить до следующего перезахода.
     * Fabric: вызывается из ServerPlayerEvents.AFTER_RESPAWN.
     */
    public static void onPlayerRespawn(ServerPlayer player) {
        int count = countCompletedChallenges(player);
        setCompletedCount(player, count);
        applyHealthBonus(player, count);
    }

    /**
     * Подсчитывает количество выполненных супер-челленджей
     * напрямую из advancement data на сервере.
     */
    private static int countCompletedChallenges(ServerPlayer player) {
        var server = player.getServer();
        if (server == null) return 0;

        ServerAdvancementManager advManager = server.getAdvancements();
        var playerAdvancements = player.getAdvancements();
        int count = 0;

        for (AdvancementHolder holder : advManager.getAllAdvancements()) {
            if (!isSuperChallenge(holder.id())) continue;

            AdvancementProgress progress = playerAdvancements.getOrStartProgress(holder);
            if (progress.isDone()) {
                count++;
            }
        }
        return count;
    }

    private static boolean isSuperChallenge(ResourceLocation id) {
        return id.getNamespace().equals("blazeandcave")
                && id.getPath().startsWith("challenges/")
                && !id.toString().equals(ROOT_ID);
    }

    private static void applyHealthBonus(ServerPlayer player, int challengeCount) {
        AttributeInstance maxHealth = player.getAttribute(Attributes.MAX_HEALTH);
        if (maxHealth == null) return;

        maxHealth.removeModifier(MODIFIER_ID);

        int bonus = Math.min(challengeCount * HP_PER_CHALLENGE, MAX_BONUS_HP);
        if (bonus <= 0) return;

        maxHealth.addPermanentModifier(new AttributeModifier(
                MODIFIER_ID, bonus, AttributeModifier.Operation.ADD_VALUE
        ));

        if (player.getHealth() > player.getMaxHealth()) {
            player.setHealth(player.getMaxHealth());
        }
    }

    private static int getCompletedCount(ServerPlayer player) {
        return player.getPersistentData().getInt("stardust:sc_count");
    }

    private static void setCompletedCount(ServerPlayer player, int count) {
        player.getPersistentData().putInt("stardust:sc_count", count);
    }
}
