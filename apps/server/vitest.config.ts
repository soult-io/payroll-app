import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    testTimeout: 60_000,
    hookTimeout: 120_000,
    // Each file boots its own PGlite; keep files isolated in separate forks.
    pool: "forks",
    poolOptions: { forks: { singleFork: false } },
    coverage: {
      provider: "v8",
      reporter: ["text-summary", "lcov"],
      // Measured 2026-07: 82.23% statements, 71.21% branches, 97.03%
      // functions, 82.23% lines. Thresholds sit ~5 points below; CI fails
      // below them.
      thresholds: {
        statements: 77,
        branches: 66,
        functions: 92,
        lines: 77,
      },
    },
  },
});
