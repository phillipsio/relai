import { defineConfig } from "vitest/config";
import path from "node:path";
import { TEST_DATABASE_URL } from "./src/test/test-db.js";

// drizzle-orm and postgres live in shared/db/node_modules, not here.
// Alias them so vite can resolve them during tests.
const DB_MODULES = path.resolve(__dirname, "../../shared/db/node_modules");

export default defineConfig({
  resolve: {
    alias: {
      "drizzle-orm": path.join(DB_MODULES, "drizzle-orm"),
      "postgres":    path.join(DB_MODULES, "postgres"),
    },
  },
  test: {
    environment: "node",
    name: "@getrelai/api",
    include: ["src/**/*.test.ts"],
    // Every test file falls back to DATABASE_URL when unset; setting it here
    // means that fallback never fires, so tests can't touch the dev DB no
    // matter what a given test file does. globalSetup truncates relai_test
    // before this run starts, so leaked rows can't survive to the next run.
    env: { DATABASE_URL: TEST_DATABASE_URL },
    globalSetup: "./src/test/global-setup.ts",
  },
});
