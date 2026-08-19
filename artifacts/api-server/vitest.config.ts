import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // Run test files serially to avoid DB contention in integration tests
    singleFork: true,
  },
});
