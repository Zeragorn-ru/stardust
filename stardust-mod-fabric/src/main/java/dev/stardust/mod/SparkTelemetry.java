package dev.stardust.mod;

import net.fabricmc.loader.api.FabricLoader;

final class SparkTelemetry {
    private SparkTelemetry() {}

    static double[] poll() {
        if (!FabricLoader.getInstance().isModLoaded("spark")) return null;
        try {
            return SparkApi.poll();
        } catch (Exception | LinkageError ignored) {
            return null;
        }
    }

    // Keep Spark types out of classes loaded when the optional mod is absent.
    private static final class SparkApi {
        static double[] poll() {
            var spark = me.lucko.spark.api.SparkProvider.get();
            if (spark == null || spark.mspt() == null || spark.tps() == null) return null;
            return new double[] {
                spark.mspt().poll(me.lucko.spark.api.statistic.StatisticWindow.MillisPerTick.MINUTES_1).mean(),
                spark.tps().poll(me.lucko.spark.api.statistic.StatisticWindow.TicksPerSecond.SECONDS_10)
            };
        }
    }
}
