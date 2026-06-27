package dev.stardust.mod;

import net.neoforged.bus.api.IEventBus;
import net.neoforged.fml.ModContainer;
import net.neoforged.fml.common.Mod;
import net.neoforged.fml.loading.FMLEnvironment;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * Общий мод Stardust для NeoForge 1.21.1 (один jar для клиента и сервера).
 *
 * <p>Серверная часть интегрируется с плагином TAB (если он установлен), чтобы
 * выставлять игрокам бейдж (tab-префикс) и цветной ник в табе. Данные о
 * бейджах/цветах сейчас берутся из локального конфига; позже их источником
 * станет backend Stardust.</p>
 */
@Mod(StardustMod.MOD_ID)
public final class StardustMod {
    public static final String MOD_ID = "stardust";
    public static final Logger LOGGER = LoggerFactory.getLogger("Stardust");

    public StardustMod(IEventBus modEventBus, ModContainer modContainer) {
        LOGGER.info("Stardust shared mod initialized (env={})", FMLEnvironment.dist);

        // TAB интеграция имеет смысл только на сервере и только если TAB
        // действительно присутствует в classpath/среде выполнения.
        if (FMLEnvironment.dist.isDedicatedServer()) {
            StardustTabIntegration.tryBootstrap();
        }
    }
}
