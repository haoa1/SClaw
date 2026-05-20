import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    testTimeout: 30_000,
    hookTimeout: 30_000,
    include: ["src/**/*.test.ts"],
    exclude: ["node_modules", "dist"],
    // Suppress noisy console output during tests
    onConsoleLog(log) {
      if (log.includes("[PluginManager]") || log.includes("[StrategyValidator]") ||
          log.includes("[DataFetcher]") || log.includes("[AgentManager]") ||
          log.includes("Failed to")) {
        return false; // suppress
      }
      return undefined;
    },
  },
});
