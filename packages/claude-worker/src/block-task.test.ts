import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { blockOverflowedTasks } from "./block-task.js";

const CONN = {
  apiUrl: "http://localhost:3010",
  apiSecret: "secret-token",
  agentId: "agent_1",
  repoId: "repo_1",
};

type Row = { id: string; metadata?: unknown };

function makeFetchMock({ tasks = [], putOk = true }: { tasks?: Row[]; putOk?: boolean } = {}) {
  return vi.fn(async (input: unknown, init?: { method?: string }) => {
    if (init?.method === "PUT") {
      return putOk
        ? { ok: true, status: 200, json: async () => ({ data: {} }) }
        : { ok: false, status: 500, statusText: "Internal Server Error" };
    }
    return { ok: true, status: 200, json: async () => ({ data: tasks }) };
  });
}

function putCalls(mock: ReturnType<typeof makeFetchMock>) {
  return mock.mock.calls.filter(([, init]) => (init as { method?: string } | undefined)?.method === "PUT");
}

function bodyOf(call: unknown[]) {
  return JSON.parse((call[1] as { body: string }).body);
}

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("blockOverflowedTasks", () => {
  it("queries only the caller's in_progress tasks in its own repo", async () => {
    const fetchMock = makeFetchMock({ tasks: [] });
    vi.stubGlobal("fetch", fetchMock);

    await blockOverflowedTasks(CONN, "prompt is too long");

    const url = String(fetchMock.mock.calls[0][0]);
    expect(url).toContain("/tasks?");
    expect(url).toContain("repoId=repo_1");
    expect(url).toContain("assignedTo=agent_1");
    expect(url).toContain("status=in_progress");
  });

  it("moves each in_progress task to blocked", async () => {
    const fetchMock = makeFetchMock({ tasks: [{ id: "task_1" }, { id: "task_2" }] });
    vi.stubGlobal("fetch", fetchMock);

    const blocked = await blockOverflowedTasks(CONN, "prompt is too long: 213539 tokens > 200000");

    expect(blocked).toEqual(["task_1", "task_2"]);
    const puts = putCalls(fetchMock);
    expect(puts).toHaveLength(2);
    expect(String(puts[0][0])).toBe("http://localhost:3010/tasks/task_1");
    expect(bodyOf(puts[0]).status).toBe("blocked");
  });

  it("merges metadata instead of clobbering it", async () => {
    const fetchMock = makeFetchMock({
      tasks: [{ id: "task_1", metadata: { branchName: "feat/x", roundNumber: 2 } }],
    });
    vi.stubGlobal("fetch", fetchMock);

    await blockOverflowedTasks(CONN, "prompt is too long");

    const meta = bodyOf(putCalls(fetchMock)[0]).metadata;
    expect(meta.branchName).toBe("feat/x");
    expect(meta.roundNumber).toBe(2);
    expect(meta.blockedReason).toMatch(/context/i);
    expect(meta.overflow.detail).toContain("prompt is too long");
  });

  it("does not set blockedThreadId, so the resume watcher leaves it alone", async () => {
    const fetchMock = makeFetchMock({ tasks: [{ id: "task_1" }] });
    vi.stubGlobal("fetch", fetchMock);

    await blockOverflowedTasks(CONN, "prompt is too long");

    expect(bodyOf(putCalls(fetchMock)[0]).metadata).not.toHaveProperty("blockedThreadId");
  });

  it("truncates the detail so a large stderr dump never lands in jsonb", async () => {
    const fetchMock = makeFetchMock({ tasks: [{ id: "task_1" }] });
    vi.stubGlobal("fetch", fetchMock);

    await blockOverflowedTasks(CONN, "prompt is too long " + "x".repeat(9000));

    expect(bodyOf(putCalls(fetchMock)[0]).metadata.overflow.detail.length).toBeLessThanOrEqual(500);
  });

  it("blocks nothing and issues no PUT when no task is in progress", async () => {
    const fetchMock = makeFetchMock({ tasks: [] });
    vi.stubGlobal("fetch", fetchMock);

    const blocked = await blockOverflowedTasks(CONN, "prompt is too long");

    expect(blocked).toEqual([]);
    expect(putCalls(fetchMock)).toHaveLength(0);
  });

  // Must not replace the session failure the caller is already handling.
  it("reports nothing blocked rather than throwing when the PUT fails", async () => {
    vi.stubGlobal("fetch", makeFetchMock({ tasks: [{ id: "task_1" }], putOk: false }));

    await expect(blockOverflowedTasks(CONN, "prompt is too long")).resolves.toEqual([]);
  });

  it("reports nothing blocked rather than throwing when the API is unreachable", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("ECONNREFUSED"); }));

    await expect(blockOverflowedTasks(CONN, "prompt is too long")).resolves.toEqual([]);
  });
});
