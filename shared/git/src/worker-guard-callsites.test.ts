import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const PACKAGES = join(__dirname, "../../../packages");
const HEADLESS = [
  ["claude-worker/src/worker.ts", "[claude-worker]"],
  ["event-worker/src/worker.ts", "[event-worker]"],
  ["copilot-worker/src/index.ts", "[copilot-worker]"],
];

describe("every headless worker refuses the top-level credential at startup", () => {
  it.each(HEADLESS)("%s calls the guard right after its repo check", (file, prefix) => {
    const text = readFileSync(join(PACKAGES, file), "utf8");
    const repoCheck = text.search(/await assertRepoOrExit\(/);
    const guard = text.indexOf(`await assertNotOwnerScopedOrExit(config, "${prefix}")`);
    expect(repoCheck).toBeGreaterThan(-1);
    expect(guard).toBeGreaterThan(repoCheck);
  });
});
