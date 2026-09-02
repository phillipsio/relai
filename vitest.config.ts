import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
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
