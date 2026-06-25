package dev.stardust.mod;

import net.fabricmc.api.ModInitializer;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

public final class StardustMod implements ModInitializer {
    public static final String MOD_ID = "stardust";
    public static final Logger LOGGER = LoggerFactory.getLogger(MOD_ID);

    @Override
    public void onInitialize() {
        LOGGER.info("Stardust shared mod initialized");
    }
}
