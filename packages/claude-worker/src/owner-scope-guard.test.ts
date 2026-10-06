import { describe, it, expect, vi, afterEach } from "vitest";
import { assertNotOwnerScopedOrExit } from "./worker.js";
import type { ClaudeWorkerConfig } from "./config.js";

const config = { apiUrl: "http://api.test", agentId: "agent_1", apiSecret: "aio_x" } as ClaudeWorkerConfig;

function stub(response: Response | Error) {
  const fetchMock = vi.fn(async () => {
    if (response instanceof Error) throw response;
    return response;
  });
  vi.stubGlobal("fetch", fetchMock);
  const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
  const err = vi.spyOn(console, "error").mockImplementation(() => {});
  return { fetchMock, exit, err };
}

const tokens = (rows: unknown[]) => new Response(JSON.stringify({ data: rows }), { status: 200 });

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("a headless worker never runs with the account's god credential", () => {
  it("exits when the presenting token is owner-scoped", async () => {
    const { exit, err } = stub(tokens([{ id: "t1", current: true, ownerScoped: true }]));
    await assertNotOwnerScopedOrExit(config);
    expect(exit).toHaveBeenCalledWith(1);
    expect(String(err.mock.calls[0][0])).toMatch(/owner-scoped/i);
  });

  it("runs with a repo-scoped token, even when a sibling token is owner-scoped", async () => {
    const { exit } = stub(tokens([
      { id: "t1", current: true, ownerScoped: false },
      { id: "t2", current: false, ownerScoped: true },
    ]));
    await assertNotOwnerScopedOrExit(config);
    expect(exit).not.toHaveBeenCalled();
  });

  it("asks about its own agent with its own token", async () => {
    const { fetchMock } = stub(tokens([{ id: "t1", current: true, ownerScoped: false }]));
    await assertNotOwnerScopedOrExit(config);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://api.test/agents/agent_1/tokens");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer aio_x");
  });

  it("runs on the shared-secret path, where no row is current and nothing carries owner scope", async () => {
    const { exit } = stub(tokens([{ id: "t1", current: null, ownerScoped: false }]));
    await assertNotOwnerScopedOrExit(config);
    expect(exit).not.toHaveBeenCalled();
  });

  it("exits when it cannot confirm, rather than running on a guess", async () => {
    for (const response of [new Error("ECONNREFUSED"), new Response("{}", { status: 500 }), new Response("not json", { status: 200 })]) {
      const { exit } = stub(response);
      await assertNotOwnerScopedOrExit(config);
      expect(exit).toHaveBeenCalledWith(1);
      vi.restoreAllMocks();
    }
  });
});
