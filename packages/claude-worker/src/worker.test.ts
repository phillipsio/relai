import { describe, it, expect, vi } from "vitest";
import type { ClaudeWorkerConfig } from "./config.js";

const refused = new Error("refused");
vi.mock("@getrelai/git", async () => ({
  ...(await vi.importActual<typeof import("@getrelai/git")>("@getrelai/git")),
  fetchRepoUrl: vi.fn().mockResolvedValue(null),
  checkRepoMatch: vi.fn().mockReturnValue({ ok: true }),
  assertNotOwnerScopedOrExit: vi.fn().mockRejectedValue(refused),
}));
vi.mock("./session.js", () => ({ runClaudeSession: vi.fn() }));

describe("runWorker", () => {
  it("refuses the top-level credential before its first session", async () => {
    const { runWorker } = await import("./worker.js");
    const { runClaudeSession } = await import("./session.js");
    const { assertNotOwnerScopedOrExit } = await import("@getrelai/git");
    vi.spyOn(console, "log").mockImplementation(() => {});

    const config = { agentId: "a", repoId: "r", apiUrl: "http://x", apiSecret: "s", repoPath: "/tmp" } as ClaudeWorkerConfig;
    await expect(runWorker(config)).rejects.toBe(refused);
    expect(vi.mocked(assertNotOwnerScopedOrExit)).toHaveBeenCalledWith(config, "[claude-worker]");
    expect(vi.mocked(runClaudeSession)).not.toHaveBeenCalled();
  });
});
