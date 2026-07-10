import { describe, it, expect, vi, beforeEach } from "vitest";
import type { EventWorkerConfig } from "./config.js";
import { runClaudeSession } from "@getrelai/claude-worker";

const esInstances: any[] = [];
class FakeEventSource {
  public init: any;
  public onopen?: () => void;
  public onmessage?: (e: any) => void;
  public onerror?: () => void;
  public listeners = new Map<string, Array<(e: any) => void>>();
  constructor(public url: string, init: any) {
    this.init = init;
    esInstances.push(this);
  }
  addEventListener(kind: string, handler: (e: any) => void) {
    const handlers = this.listeners.get(kind) ?? [];
    handlers.push(handler);
    this.listeners.set(kind, handlers);
  }
  dispatch(kind: string, data: unknown) {
    for (const handler of this.listeners.get(kind) ?? []) {
      handler({ data: JSON.stringify(data) });
    }
  }
  close() {}
}
vi.mock("eventsource", () => ({ EventSource: FakeEventSource }));

vi.mock("@getrelai/claude-worker", () => ({
  runClaudeSession: vi.fn().mockResolvedValue(undefined),
  heartbeat: vi.fn().mockResolvedValue(undefined),
  assertRepoOrExit: vi.fn().mockResolvedValue(undefined),
}));

const TEST_CONFIG: EventWorkerConfig = {
  agentId: "agent_1",
  repoId: "repo_1",
  apiUrl: "http://localhost:3010",
  apiSecret: "secret-token",
  repoPath: "/tmp/repo",
  pollIntervalMs: 15_000,
  maxBackoffMs: 300_000,
  maxTaskRounds: 5,
  model: "sonnet",
  specialization: "writer",
  claudeBin: "claude",
  reconnectBaseMs: 2_000,
  reconnectMaxMs: 60_000,
};

// Mocks the has-work check's two GET calls (plus selfSubscribe's POST) by URL.
// `failHasWorkCheck` simulates a network blip on the has-work signals specifically.
function makeFetchMock({ tasks = [], messages = [], failHasWorkCheck = false }: { tasks?: unknown[]; messages?: unknown[]; failHasWorkCheck?: boolean } = {}) {
  return vi.fn(async (input: unknown) => {
    const url = String(input);
    if (url.includes("/subscriptions")) return { ok: true };
    if (failHasWorkCheck) throw new Error("network blip");
    if (url.includes("/tasks")) return { ok: true, json: async () => ({ data: tasks }) };
    if (url.includes("/messages/unread")) return { ok: true, json: async () => ({ data: messages }) };
    return { ok: true };
  });
}

async function flushMicrotasks(times = 10): Promise<void> {
  for (let i = 0; i < times; i++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

describe("runEventWorker", () => {
  beforeEach(() => {
    // Reset call history between tests. Without this, runClaudeSession's mock
    // accumulates calls across the file, so the spawn/message/fallback tests
    // below would pass on toHaveBeenCalled() even if their own code path never
    // spawned (a false pass). clearAllMocks resets .mock.calls only — the
    // factory's mockResolvedValue implementations are preserved.
    vi.clearAllMocks();
    esInstances.length = 0;
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true }));
  });

  it("injects the Authorization header via the fetch option, not a (silently-ignored) headers option", async () => {
    // eventsource@3's EventSourceInit has no `headers` field — only
    // `withCredentials`/`fetch`. Passing `headers` directly is silently
    // dropped at runtime, so every connection 401s with no auth header ever
    // sent. This pins the fix: the Authorization header must travel through
    // the documented `fetch` hook.
    const { runEventWorker } = await import("./worker.js");

    const config: EventWorkerConfig = {
      agentId: "agent_1",
      repoId: "repo_1",
      apiUrl: "http://localhost:3010",
      apiSecret: "secret-token",
      repoPath: "/tmp/repo",
      pollIntervalMs: 15_000,
      maxBackoffMs: 300_000,
      maxTaskRounds: 5,
      model: "sonnet",
      specialization: "writer",
      claudeBin: "claude",
      reconnectBaseMs: 2_000,
      reconnectMaxMs: 60_000,
    };

    void runEventWorker(config);
    // selfSubscribe's fetch resolves over a handful of microtask hops before
    // connect() runs; flush microtasks deterministically rather than betting
    // on a fixed timeout being long enough.
    for (let i = 0; i < 10 && esInstances.length === 0; i++) {
      await new Promise((resolve) => setImmediate(resolve));
    }

    expect(esInstances).toHaveLength(1);
    const init = esInstances[0].init;
    expect(init.headers).toBeUndefined();
    expect(typeof init.fetch).toBe("function");

    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchMock);
    // eventsource always sends Accept, and adds Last-Event-ID on reconnect —
    // a regression that rebuilt `headers` instead of spreading `...init?.headers`
    // would still pass an Authorization-only assertion while silently dropping
    // both, breaking SSE negotiation and resumption. Assert all three survive.
    await init.fetch("http://localhost:3010/events", {
      headers: { Accept: "text/event-stream", "Last-Event-ID": "42" },
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:3010/events",
      expect.objectContaining({
        headers: {
          Accept: "text/event-stream",
          "Last-Event-ID": "42",
          Authorization: "Bearer secret-token",
        },
      }),
    );
  });

  it("wakes the run queue on a named SSE event, not just onmessage", async () => {
    // The API sends named events (`event: task.created`, etc. — see
    // packages/api/src/routes/events.ts), which the SSE spec delivers only to
    // listeners registered via addEventListener, never to onmessage. This
    // pins the fix: a named event must still trigger the run-queue notify.
    const { runEventWorker } = await import("./worker.js");
    const runClaudeSessionMock = vi.mocked(runClaudeSession);

    const config: EventWorkerConfig = {
      agentId: "agent_1",
      repoId: "repo_1",
      apiUrl: "http://localhost:3010",
      apiSecret: "secret-token",
      repoPath: "/tmp/repo",
      pollIntervalMs: 15_000,
      maxBackoffMs: 300_000,
      maxTaskRounds: 5,
      model: "sonnet",
      specialization: "writer",
      claudeBin: "claude",
      reconnectBaseMs: 2_000,
      reconnectMaxMs: 60_000,
    };

    void runEventWorker(config);
    for (let i = 0; i < 10 && esInstances.length === 0; i++) {
      await new Promise((resolve) => setImmediate(resolve));
    }

    const es = esInstances[0];
    expect(typeof es.addEventListener).toBe("function");

    // Let the startup queue.notify() drain before measuring the delta.
    for (let i = 0; i < 10; i++) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    const callsBefore = runClaudeSessionMock.mock.calls.length;
    expect(callsBefore).toBeGreaterThan(0);

    es.dispatch("task.created", { kind: "task.created" });

    for (let i = 0; i < 10; i++) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    expect(runClaudeSessionMock.mock.calls.length).toBeGreaterThan(callsBefore);
  });

  it("skips spawning a session when there are no assigned tasks and no unread messages", async () => {
    vi.stubGlobal("fetch", makeFetchMock({ tasks: [], messages: [] }));
    const { runEventWorker } = await import("./worker.js");
    const runClaudeSessionMock = vi.mocked(runClaudeSession);

    void runEventWorker(TEST_CONFIG);
    await flushMicrotasks();

    expect(runClaudeSessionMock).not.toHaveBeenCalled();
  });

  it("spawns a session when an assigned task is present", async () => {
    vi.stubGlobal("fetch", makeFetchMock({ tasks: [{ id: "task_1" }], messages: [] }));
    const { runEventWorker } = await import("./worker.js");
    const runClaudeSessionMock = vi.mocked(runClaudeSession);

    void runEventWorker(TEST_CONFIG);
    await flushMicrotasks();

    // Exactly one spawn from the single startup queue.notify() (no SSE events
    // dispatched here), which the per-test clearAllMocks now makes assertable.
    expect(runClaudeSessionMock).toHaveBeenCalledTimes(1);
  });

  it("spawns a session when an unread message is present", async () => {
    vi.stubGlobal("fetch", makeFetchMock({ tasks: [], messages: [{ id: "msg_1" }] }));
    const { runEventWorker } = await import("./worker.js");
    const runClaudeSessionMock = vi.mocked(runClaudeSession);

    void runEventWorker(TEST_CONFIG);
    await flushMicrotasks();

    expect(runClaudeSessionMock).toHaveBeenCalledTimes(1);
  });

  it("falls through to spawning a session when the has-work check errors", async () => {
    vi.stubGlobal("fetch", makeFetchMock({ failHasWorkCheck: true }));
    const { runEventWorker } = await import("./worker.js");
    const runClaudeSessionMock = vi.mocked(runClaudeSession);

    void runEventWorker(TEST_CONFIG);
    await flushMicrotasks();

    expect(runClaudeSessionMock).toHaveBeenCalledTimes(1);
  });
});
