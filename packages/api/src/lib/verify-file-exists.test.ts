import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runFileExistsVerification } from "./verify-file-exists.js";

let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "relai-fxv-"));
  await writeFile(join(dir, "exists.txt"), "ok");
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("runFileExistsVerification", () => {
  it("exits 0 when the file exists (absolute path)", async () => {
    const r = await runFileExistsVerification(join(dir, "exists.txt"));
    expect(r.exitCode).toBe(0);
    expect(r.timedOut).toBe(false);
  });

  it("exits 1 when the file is missing", async () => {
    const r = await runFileExistsVerification(join(dir, "nope.txt"));
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("nope.txt");
  });

  it("resolves relative paths against verifyCwd", async () => {
    const hit = await runFileExistsVerification("exists.txt", dir);
    expect(hit.exitCode).toBe(0);
    const miss = await runFileExistsVerification("ghost.txt", dir);
    expect(miss.exitCode).toBe(1);
  });
});
