import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Each api test file opens two postgres-js pools (max 10 each), so
    // unbounded forks starve Postgres' 100 connections and the suite times out.
    maxWorkers: 4,
    projects: [
      "packages/mcp-server",
      "packages/api/vitest.config.ts",
      "packages/claude-worker",
      "packages/event-worker",
      "packages/agent",
      "packages/cli",
      "shared/git",
    ],
  },
});
