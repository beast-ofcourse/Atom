import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    setupFiles: ["./tests/setup.ts"],
    // TUI integration reality: most suites drive a real Ink tree with real
    // timers (1s+ waits), so the 5s default flakes whenever workers contend
    // for CPU. Generous per-test budget plus a worker cap at typical core
    // counts keeps full-suite runs green without touching test logic.
    testTimeout: 30000,
    maxWorkers: 4,
  },
});
