import { describe, it, expect, vi, afterEach } from "vitest";
import { ApiClient } from "./api-client.js";

function mockFetchOk() {
  return vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({ data: [] }),
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("ApiClient auth headers", () => {
  it("sends the bearer token and no X-Owner-Id by default (per-agent mode)", async () => {
    const fetchMock = mockFetchOk();
    vi.stubGlobal("fetch", fetchMock);
    const client = new ApiClient({ baseUrl: "http://api.test", secret: "agent-token" });
    await client.getTasks({ repoId: "proj_1" });

    const headers = fetchMock.mock.calls[0][1].headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer agent-token");
    expect(headers["X-Owner-Id"]).toBeUndefined();
  });

  it("sends the service-admin token plus X-Owner-Id in owner mode", async () => {
    const fetchMock = mockFetchOk();
    vi.stubGlobal("fetch", fetchMock);
    const client = new ApiClient({ baseUrl: "http://api.test", secret: "svc-admin", ownerId: "usr_abc" });
    await client.getTasks({ status: "blocked" });

    const [url, init] = fetchMock.mock.calls[0];
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer svc-admin");
    expect(headers["X-Owner-Id"]).toBe("usr_abc");
    // Owner-mode list calls omit repoId — the API scopes by owner.
    expect(String(url)).not.toContain("repoId");
  });
});

describe("getTasksPage", () => {
  it("builds the querystring from every param and returns the envelope unwrapped", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ data: [{ id: "task_1" }], meta: { total: 1, returned: 1 } }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const client = new ApiClient({ baseUrl: "http://api.test", secret: "t" });

    const result = await client.getTasksPage({ repoId: "proj_1", limit: 5, clip: true });

    const url = new URL(String(fetchMock.mock.calls[0][0]));
    expect(url.searchParams.get("repoId")).toBe("proj_1");
    expect(url.searchParams.get("limit")).toBe("5");
    expect(url.searchParams.get("clip")).toBe("true");
    expect(result).toEqual({ data: [{ id: "task_1" }], meta: { total: 1, returned: 1 } });
  });

  it("sends clip=false as a literal string, not dropped — v != null keeps false", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ data: [], meta: { total: 0, returned: 0 } }) });
    vi.stubGlobal("fetch", fetchMock);
    const client = new ApiClient({ baseUrl: "http://api.test", secret: "t" });

    await client.getTasksPage({ repoId: "proj_1", clip: false });

    const url = new URL(String(fetchMock.mock.calls[0][0]));
    expect(url.searchParams.get("clip")).toBe("false");
  });
});

describe("getAgent", () => {
  it("unwraps the envelope and returns repoPath directly, not the raw response", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ data: { id: "agent_1", repoPath: "/Users/x/repo" } }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const client = new ApiClient({ baseUrl: "http://api.test", secret: "t" });

    const agent = await client.getAgent("agent_1");

    expect(String(fetchMock.mock.calls[0][0])).toBe("http://api.test/agents/agent_1");
    expect(agent).toEqual({ id: "agent_1", repoPath: "/Users/x/repo" });
  });
});

describe("a 204 is a success, not a parse error", () => {
  // DELETE /invites/:id answers 204 with an empty body. requestEnvelope called
  // res.json() unconditionally, which rejects on empty input, so revokeInvite
  // threw on every success: the invite WAS revoked and the model was told the
  // call failed. That is the worst possible direction for the one tool whose
  // job is killing a code that may have leaked.
  it("resolves rather than throwing when the route returns no body", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 204,
      json: async () => { throw new SyntaxError("Unexpected end of JSON input"); },
    });
    vi.stubGlobal("fetch", fetchMock);
    const client = new ApiClient({ baseUrl: "http://api.test", secret: "t" });
    await expect(client.revokeInvite("invite_abc")).resolves.toBeUndefined();
    expect(String(fetchMock.mock.calls[0][0])).toBe("http://api.test/invites/invite_abc");
    expect(fetchMock.mock.calls[0][1].method).toBe("DELETE");
  });

  it("still surfaces an error status that carries no body", async () => {
    // Failing closed matters more here than a tidy message: a revoke that did
    // not happen must not read as one that did.
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      json: async () => { throw new SyntaxError("Unexpected end of JSON input"); },
    });
    vi.stubGlobal("fetch", fetchMock);
    const client = new ApiClient({ baseUrl: "http://api.test", secret: "t" });
    await expect(client.revokeInvite("invite_missing")).rejects.toThrow(/404/);
  });

  it("leaves a normal JSON response alone", async () => {
    const fetchMock = mockFetchOk();
    vi.stubGlobal("fetch", fetchMock);
    const client = new ApiClient({ baseUrl: "http://api.test", secret: "t" });
    await expect(client.listInvites("repo_1")).resolves.toEqual([]);
  });
});
