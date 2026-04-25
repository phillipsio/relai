import { defineConfig } from "vitest/config";
import path from "node:path";

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
    name: "@relai/api",
    include: ["src/**/*.test.ts"],
  },
});
