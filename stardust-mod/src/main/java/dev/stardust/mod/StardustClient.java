package dev.stardust.mod;

import net.fabricmc.api.ClientModInitializer;

public final class StardustClient implements ClientModInitializer {
    @Override
    public void onInitializeClient() {
        StardustMod.LOGGER.info("Stardust client hooks initialized");
    }
}
