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
    await client.getTasks({ projectId: "proj_1" });

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
    // Owner-mode list calls omit projectId — the API scopes by owner.
    expect(String(url)).not.toContain("projectId");
  });
});
