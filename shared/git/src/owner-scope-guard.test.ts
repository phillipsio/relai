import { describe, it, expect, vi, afterEach } from "vitest";
import { assertNotOwnerScopedOrExit } from "./index.js";

const config = { apiUrl: "http://api.test", agentId: "agent_1", apiSecret: "aio_x" };

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

describe("a headless worker never runs with the account's top-level credential", () => {
  it("exits when the presenting token is owner-scoped", async () => {
    const { exit, err } = stub(tokens([{ id: "t1", current: true, ownerScoped: true }]));
    await assertNotOwnerScopedOrExit(config, "[w]");
    expect(exit).toHaveBeenCalledWith(1);
    expect(String(err.mock.calls[0][0])).toMatch(/^\[w\] .*owner-scoped/i);
  });

  it("runs with its own repo-scoped token, even when a sibling token is owner-scoped", async () => {
    const { exit } = stub(tokens([
      { id: "t1", current: true, ownerScoped: false },
      { id: "t2", current: false, ownerScoped: true },
    ]));
    await assertNotOwnerScopedOrExit(config, "[w]");
    expect(exit).not.toHaveBeenCalled();
  });

  it("exits when the bearer is not one of this agent's tokens, as a borrowed top-level token would be", async () => {
    const { exit } = stub(tokens([{ id: "t1", current: false, ownerScoped: false }]));
    await assertNotOwnerScopedOrExit(config, "[w]");
    expect(exit).toHaveBeenCalledWith(1);
  });

  it("runs on the shared-secret path, where no row can be current and nothing carries owner scope", async () => {
    const { exit } = stub(tokens([{ id: "t1", current: null, ownerScoped: false }]));
    await assertNotOwnerScopedOrExit(config, "[w]");
    expect(exit).not.toHaveBeenCalled();
  });

  it("asks about its own agent with its own bearer", async () => {
    const { fetchMock } = stub(tokens([{ id: "t1", current: true, ownerScoped: false }]));
    await assertNotOwnerScopedOrExit(config, "[w]");
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://api.test/agents/agent_1/tokens");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer aio_x");
  });

  it.each([
    ["a network error", new Error("ECONNREFUSED")],
    ["a server error", new Response("{}", { status: 500 })],
    ["a body that is not JSON", new Response("not json", { status: 200 })],
    ["a body with no list", new Response("{}", { status: 200 })],
    ["an empty list", tokens([])],
  ])("exits on %s, rather than running on a guess", async (_label, response) => {
    const { exit } = stub(response);
    await assertNotOwnerScopedOrExit(config, "[w]");
    expect(exit).toHaveBeenCalledWith(1);
  });
});
