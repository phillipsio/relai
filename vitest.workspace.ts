import { defineWorkspace } from "vitest/config";

export default defineWorkspace([
  "packages/mcp-server",
  "packages/api/vitest.config.ts",
  "packages/claude-worker",
  "packages/event-worker",
  "packages/agent",
  "packages/cli",
  "shared/git",
]);
