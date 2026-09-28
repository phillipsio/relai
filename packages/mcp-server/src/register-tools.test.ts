// The wiring, not the builders. Deleting `await registerTools()` from main()
// left the entire package suite green at 190 tests: a server registering zero
// tools was indistinguishable from a healthy one. Hardcoding `ownerScoped:
// false` here would be the original defect re-introduced one layer down, and
// nothing would have caught that either.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { registerTools } from "./register-tools.js";
import type { ApiClient } from "./api-client.js";

const client = {} as ApiClient;
const spyServer = () => {
  const tool = vi.fn();
  return { server: { tool }, names: () => tool.mock.calls.map((c) => c[0] as string) };
};

beforeEach(() => { vi.spyOn(console, "error").mockImplementation(() => {}); });
afterEach(() => { vi.restoreAllMocks(); });

describe("registerTools actually registers what the config implies", () => {
  it("registers every tool on the server, not just returns a list", async () => {
    const { server, names } = spyServer();
    const returned = await registerTools(server, client,
      { ownerMode: false, agentId: "a", repoId: "r" }, async () => false);
    expect(names().length).toBeGreaterThan(20);
    expect(names()).toEqual(returned);
  });

  it("asks the credential and registers the provisioning tools when it says yes", async () => {
    const detect = vi.fn().mockResolvedValue(true);
    const { server, names } = spyServer();
    await registerTools(server, client, { ownerMode: false, agentId: "a", repoId: "r" }, detect);
    expect(detect).toHaveBeenCalledWith(client, "a");
    expect(names()).toContain("create_repo");
    expect(names()).toContain("session_start");
  });

  it("registers no provisioning tools when it says no", async () => {
    const { server, names } = spyServer();
    await registerTools(server, client, { ownerMode: false, agentId: "a", repoId: "r" }, async () => false);
    expect(names()).not.toContain("create_repo");
    expect(names()).toContain("session_start");
  });

  it("never asks in owner mode, where the question does not apply", async () => {
    const detect = vi.fn();
    const { server, names } = spyServer();
    await registerTools(server, client, { ownerMode: true, ownerId: "usr_1" }, detect);
    expect(detect).not.toHaveBeenCalled();
    expect(names()).toContain("reply_human");
  });

  it("registers each name exactly once, since a duplicate breaks registration", async () => {
    const { server, names } = spyServer();
    await registerTools(server, client, { ownerMode: false, agentId: "a", repoId: "r" }, async () => true);
    expect(names().length).toBe(new Set(names()).size);
  });
});
