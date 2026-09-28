// Does the credential this server is holding carry owner scope?
//
// The answer decides which tools get registered, and registration happens at
// startup BEFORE the client connects. AGENTS.md records that a slow MCP startup
// is not a degraded connection but no connection at all: the npx bug meant a
// session got no live tools because the server did not answer inside Claude
// Code's window. So this call is bounded, and every way it can fail resolves to
// "not owner-scoped" rather than to a hang or a guess.
//
// Failing closed costs an owner-scoped agent a restart. Failing open would
// advertise tools the credential cannot back, and a hang would cost every agent
// on the instance its entire toolset.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { detectOwnerScope } from "./owner-scope.js";
import type { ApiClient } from "./api-client.js";

const AGENT = "agent_1";
const client = (listAgentTokens: unknown) => ({ listAgentTokens }) as unknown as ApiClient;

let stderr: ReturnType<typeof vi.spyOn>;
beforeEach(() => { stderr = vi.spyOn(console, "error").mockImplementation(() => {}); });
afterEach(() => { vi.restoreAllMocks(); });

describe("detectOwnerScope reads the row that authenticated this request", () => {
  it("is true when the current token carries owner scope", async () => {
    const list = vi.fn().mockResolvedValue([
      { id: "tok_old", ownerScoped: false, current: false },
      { id: "tok_now", ownerScoped: true,  current: true  },
    ]);
    await expect(detectOwnerScope(client(list), AGENT)).resolves.toBe(true);
  });

  it("is false when the current token is repo-scoped, whatever its siblings carry", async () => {
    // A sibling being owner-scoped says nothing about the credential in hand.
    // Reading any row rather than the current one is how an ordinary token
    // would inherit another's authority.
    const list = vi.fn().mockResolvedValue([
      { id: "tok_sibling", ownerScoped: true,  current: false },
      { id: "tok_now",     ownerScoped: false, current: true  },
    ]);
    await expect(detectOwnerScope(client(list), AGENT)).resolves.toBe(false);
  });

  it("is false when no row is marked current, because the server could not tell", async () => {
    // `current` is null on the shared-secret and owner paths, where nothing
    // resolved a token row. Absent evidence is not evidence.
    const list = vi.fn().mockResolvedValue([
      { id: "tok_a", ownerScoped: true, current: null },
      { id: "tok_b", ownerScoped: true, current: null },
    ]);
    await expect(detectOwnerScope(client(list), AGENT)).resolves.toBe(false);
  });

  it("is false on an empty list", async () => {
    await expect(detectOwnerScope(client(vi.fn().mockResolvedValue([])), AGENT)).resolves.toBe(false);
  });
});

describe("every failure resolves to false, and says so out loud", () => {
  it("does not throw when the API refuses, and logs", async () => {
    const list = vi.fn().mockRejectedValue(new Error("API error 403"));
    await expect(detectOwnerScope(client(list), AGENT)).resolves.toBe(false);
    expect(stderr).toHaveBeenCalled();
    expect(String(stderr.mock.calls[0][0])).toMatch(/owner scope/i);
  });

  it("does not throw when the response is not a list", async () => {
    const list = vi.fn().mockResolvedValue({ nope: true });
    await expect(detectOwnerScope(client(list), AGENT)).resolves.toBe(false);
    expect(stderr).toHaveBeenCalled();
  });

  it("gives up on its own deadline rather than holding startup open", async () => {
    // The whole point of the bound. A client that never settles must not be
    // able to stop the server registering tools and connecting.
    // Assert against the deadline PASSED, not a round number far above it. At
    // `< 2000` for a 40ms deadline, hardcoding the timer to 1000ms shipped green
    // — the bound is the only property the startup-safety argument rests on.
    const list = vi.fn().mockReturnValue(new Promise(() => {}));
    const started = Date.now();
    await expect(detectOwnerScope(client(list), AGENT, 40)).resolves.toBe(false);
    expect(Date.now() - started).toBeLessThan(400);
    expect(stderr).toHaveBeenCalled();
    expect(String(stderr.mock.calls[0][0])).toMatch(/timed out|timeout/i);
  });

  it("never logs silently, because a silent catch is how the last one hid", async () => {
    // The logging-capability bug was dead from the day it was written and
    // looked merely quiet, because both poll loops swallowed the throw.
    const list = vi.fn().mockRejectedValue(new Error("boom"));
    await detectOwnerScope(client(list), AGENT);
    expect(stderr).toHaveBeenCalledTimes(1);
  });

  it("stays quiet on the ordinary repo-scoped answer, which is not a failure", async () => {
    const list = vi.fn().mockResolvedValue([{ id: "t", ownerScoped: false, current: true }]);
    await detectOwnerScope(client(list), AGENT);
    expect(stderr).not.toHaveBeenCalled();
  });
});
