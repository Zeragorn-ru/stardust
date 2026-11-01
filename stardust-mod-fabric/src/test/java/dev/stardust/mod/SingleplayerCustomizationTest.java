package dev.stardust.mod;

import com.mojang.authlib.GameProfile;
import com.sun.net.httpserver.HttpServer;
import net.fabricmc.loader.api.FabricLoader;
import net.minecraft.SharedConstants;
import net.minecraft.server.Bootstrap;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.server.players.PlayerList;
import org.junit.BeforeClass;
import org.junit.Test;
import org.mockito.MockedStatic;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;

import static org.junit.Assert.*;
import static org.mockito.Mockito.*;

/** Реальный HTTP без TAB, игрового клиента и заранее заполненного кеша. */
public class SingleplayerCustomizationTest {
    @BeforeClass
    public static void bootstrapMinecraft() {
        SharedConstants.tryDetectVersion();
        Bootstrap.bootStrap();
    }

    @Test
    public void integratedServerPublishesPlayersBeforeTelemetryGuard() {
        MinecraftServer server = mock(MinecraftServer.class);
        PlayerList players = mock(PlayerList.class);
        ServerPlayer player = mock(ServerPlayer.class);
        when(server.getPlayerList()).thenReturn(players);
        when(server.isDedicatedServer()).thenReturn(false);
        when(players.getPlayers()).thenReturn(List.of(player));
        when(player.getGameProfile()).thenReturn(new GameProfile(UUID.randomUUID(), "Solo"));

        StardustServerLifecycle.onServerTick(server);
        assertEquals(List.of("Solo"), StardustServerLifecycle.onlinePlayerNames());
        when(players.getPlayers()).thenReturn(List.of());
        StardustServerLifecycle.onServerTick(server);
        assertTrue(StardustServerLifecycle.onlinePlayerNames().isEmpty());
        verify(server, never()).getTickCount();
    }

    @Test
    public void customizationRefreshWorksWithoutTabManuallyAndPeriodically() throws Exception {
        assertThrows(ClassNotFoundException.class, () -> Class.forName("me.neznamy.tab.api.TabAPI"));
        var config = Files.createTempDirectory("stardust-customization-test");
        var request = new AtomicReference<String>();
        var refreshed = new CountDownLatch(2);
        HttpServer http = HttpServer.create(new java.net.InetSocketAddress("127.0.0.1", 0), 0);
        http.createContext("/api/server/customization", exchange -> {
            request.set(exchange.getRequestURI().getRawQuery());
            byte[] body = "{\"solo\":{\"badge\":\"STAR\",\"name_color\":\"#12AB34\"}}".getBytes(StandardCharsets.UTF_8);
            exchange.sendResponseHeaders(200, body.length);
            try (var output = exchange.getResponseBody()) { output.write(body); }
        });
        http.start();
        StardustHttpProvider provider = null;
        Files.writeString(config.resolve("stardust-server.properties"),
                "stardust.auth-url=http://127.0.0.1:" + http.getAddress().getPort()
                        + "\nstardust.refresh-interval-seconds=3\n");
        try (MockedStatic<FabricLoader> loaderStatic = mockStatic(FabricLoader.class)) {
            FabricLoader loader = mock(FabricLoader.class);
            loaderStatic.when(FabricLoader::getInstance).thenReturn(loader);
            when(loader.getConfigDir()).thenReturn(config);
            StardustTabIntegration.tryBootstrap();
            provider = StardustTabIntegration.getHttpProvider();
            assertNull(provider.lookup("Solo"));
            assertEquals("Solo", StardustTabIntegration.resolveNameForChat("Solo"));
            MinecraftServer server = mock(MinecraftServer.class);
            PlayerList players = mock(PlayerList.class);
            ServerPlayer player = mock(ServerPlayer.class);
            when(server.getPlayerList()).thenReturn(players);
            when(players.getPlayers()).thenReturn(List.of(player));
            when(player.getGameProfile()).thenReturn(new GameProfile(UUID.randomUUID(), "Solo"));
            StardustServerLifecycle.onServerTick(server);
            provider.setAfterRefresh(() -> {
                // Тот же опциональный TAB-потребитель, что вызывается после HTTP.
                StardustTabIntegration.updateAllPlayersQuietly();
                refreshed.countDown();
            });
            // Проверяет также отсутствие LinkageError в команде без TAB.
            StardustTabIntegration.refreshNow();
            assertTrue("manual + periodic HTTP refresh", refreshed.await(15, TimeUnit.SECONDS));
            assertEquals("players=solo", request.get());
            assertEquals("STAR ", StardustTabIntegration.resolveBadgeForName("Solo"));
            assertEquals("&#12AB34Solo", StardustTabIntegration.resolveNameForChat("Solo"));
            assertTrue(Files.exists(config.resolve("stardust-customization-cache.json")));
            var level = mock(net.minecraft.server.level.ServerLevel.class);
            when(player.level()).thenReturn(level);
            when(level.getServer()).thenReturn(server);
            var captured = org.mockito.ArgumentCaptor.forClass(net.minecraft.network.chat.Component.class);
            assertFalse(StardustServerLifecycle.onServerChat(
                    net.minecraft.network.chat.PlayerChatMessage.unsigned(UUID.randomUUID(), "hello"), player));
            verify(players).broadcastSystemMessage(captured.capture(), eq(false));
            assertEquals("[STAR Solo] hello", captured.getValue().getString());
            assertTrue(captured.getValue().toFlatList().stream().anyMatch(component ->
                    component.getStyle().getColor() != null
                            && component.getStyle().getColor().getValue() == 0x12AB34));
        } finally {
            if (provider != null) provider.stop();
            http.stop(0);
            try (var paths = Files.walk(config)) {
                for (var path : paths.sorted(java.util.Comparator.reverseOrder()).toList()) Files.delete(path);
            }
        }
    }
}
