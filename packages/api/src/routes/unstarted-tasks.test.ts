// A task that was assigned and then never picked up is invisible to every
// watcher this system has. `detectStalls` only scans `in_progress`, so an
// `assigned` row whose worker never woke is not stall-detectable; SSE is
// live-only with no redelivery, so the assignment notice is gone; and
// `agents.lastSeenAt` says the agent is online because any authenticated
// request bumps it, including a poll from a session that cannot act. Measured
// once as a 28-hour silence that nothing surfaced.
//
// The fix is a read, not a delivery: the row says so wherever anyone looks,
// including the assignee's own `/session/start`. That is the point of doing it
// this way — it needs no delivery guarantee to work, and the thing that failed
// was delivery.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { buildServer } from "../server.js";
import { createDb, tasks } from "@getrelai/db";
import { eq } from "drizzle-orm";
import { humanizeTaskStatus } from "@getrelai/types";
import type { FastifyInstance } from "fastify";

const DB_URL = process.env.DATABASE_URL ?? "postgresql://relai:relai@localhost:5433/relai";
const SECRET = "test-secret-unstarted";

process.env.DATABASE_URL = DB_URL;
process.env.API_SECRET   = SECRET;
// Read lazily by the route, so setting it here (after import) must take effect.
process.env.UNSTARTED_AFTER_MS = "1000";

const ADMIN = { Authorization: `Bearer ${SECRET}`, "Content-Type": "application/json" };
const as = (t: string) => ({ Authorization: `Bearer ${t}`, "Content-Type": "application/json" });

const db = createDb(DB_URL);
let app: FastifyInstance;
let repoId: string;
let agentId: string;
let agentToken: string;

beforeAll(async () => {
  app = buildServer({ logger: false, scheduler: false });
  await app.ready();

  const project = await app.inject({
    method: "POST", url: "/repos", headers: ADMIN,
    body: JSON.stringify({ name: "__test__ unstarted" }),
  });
  repoId = project.json().data.id;

  const a = await app.inject({
    method: "POST", url: "/agents", headers: ADMIN,
    body: JSON.stringify({ repoId, name: "unstarted-agent", role: "worker" }),
  });
  agentId    = a.json().data.id;
  agentToken = a.json().token;
});

afterAll(async () => {
  if (repoId) await app.inject({ method: "DELETE", url: `/repos/${repoId}`, headers: ADMIN });
  await app?.close();
});

async function makeTask(status: string, updatedMsAgo: number): Promise<string> {
  const create = await app.inject({
    method: "POST", url: "/tasks", headers: ADMIN,
    body: JSON.stringify({
      repoId, createdBy: agentId, title: `unstarted-${status}`, description: "x",
      assignedTo: agentId, status,
    }),
  });
  const id = create.json().data.id as string;
  if (updatedMsAgo > 0) {
    await db.update(tasks)
      .set({ updatedAt: new Date(Date.now() - updatedMsAgo) })
      .where(eq(tasks.id, id));
  }
  return id;
}

const labelOf = (rows: Array<{ id: string; humanLabel?: string }>, id: string) =>
  rows.find((r) => r.id === id)?.humanLabel;

describe("humanizeTaskStatus names an assigned task nobody picked up", () => {
  const old  = new Date(Date.now() - 60_000);
  const now  = new Date();
  const opts = { unstartedAfterMs: 1000 };

  it("says Not picked up when assigned and untouched past the threshold", () => {
    expect(humanizeTaskStatus({ status: "assigned", updatedAt: old }, opts)).toBe("Not picked up");
  });

  it("still says Starting while the task is fresh", () => {
    expect(humanizeTaskStatus({ status: "assigned", updatedAt: now }, opts)).toBe("Starting");
  });

  it("says Starting when the caller passes no updatedAt, rather than raising a false alarm", () => {
    // Every existing caller is in this shape. A missing timestamp must read as
    // "nothing known", never as "nobody picked it up".
    expect(humanizeTaskStatus({ status: "assigned" }, opts)).toBe("Starting");
  });

  it("leaves in_progress to the stall vocabulary, however old it is", () => {
    // Two labels for one row would make both mean nothing, and `stalledAt` is
    // the field the reaper acts on. This label covers the gap stalls leave.
    expect(humanizeTaskStatus({ status: "in_progress", updatedAt: old }, opts)).toBe("Running");
    expect(humanizeTaskStatus({ status: "in_progress", updatedAt: old, stalledAt: old }, opts)).toBe("Stalled");
  });

  it("leaves every other status alone", () => {
    expect(humanizeTaskStatus({ status: "blocked", updatedAt: old }, opts)).toBe("Input required");
    expect(humanizeTaskStatus({ status: "completed", updatedAt: old }, opts)).toBe("Done");
    expect(humanizeTaskStatus({ status: "pending", updatedAt: old, autoAssign: true }, opts)).toBe("Queued");
  });

  it("honours a threshold the caller sets, and defaults when it does not", () => {
    expect(humanizeTaskStatus({ status: "assigned", updatedAt: old }, { unstartedAfterMs: 10 * 60_000 }))
      .toBe("Starting");
    // No opts at all: the default is hours, so a minute-old task is fresh.
    expect(humanizeTaskStatus({ status: "assigned", updatedAt: old })).toBe("Starting");
  });

  it("treats an unparseable timestamp as fresh rather than as a silence", () => {
    expect(humanizeTaskStatus({ status: "assigned", updatedAt: "not a date" }, opts)).toBe("Starting");
  });
});

describe("the label reaches every surface someone would look at", () => {
  let staleId: string;
  let freshId: string;
  let oldRunningId: string;

  beforeAll(async () => {
    staleId      = await makeTask("assigned", 60_000);
    freshId      = await makeTask("assigned", 0);
    oldRunningId = await makeTask("in_progress", 60_000);
  });

  it("GET /tasks labels the untouched one and only it", async () => {
    const res = await app.inject({ method: "GET", url: `/tasks?repoId=${repoId}`, headers: ADMIN });
    expect(res.statusCode).toBe(200);
    const rows = res.json().data;
    expect(rows.length).toBeGreaterThanOrEqual(3);
    expect(labelOf(rows, staleId)).toBe("Not picked up");
    expect(labelOf(rows, freshId)).toBe("Starting");
    expect(labelOf(rows, oldRunningId)).toBe("Running");
  });

  it("labels it on the clipped, capped path too, not just the unbounded one", async () => {
    // The clip is opt-in; the label must not be, or the two MCP tools that
    // always pass clip=true would be the surfaces that never show it.
    const res = await app.inject({
      method: "GET", url: `/tasks?repoId=${repoId}&clip=true&limit=50`, headers: ADMIN,
    });
    expect(labelOf(res.json().data, staleId)).toBe("Not picked up");
  });

  it("GET /tasks/:id agrees, so the drill-in does not contradict the list", async () => {
    const res = await app.inject({ method: "GET", url: `/tasks/${staleId}`, headers: ADMIN });
    expect(res.json().data.humanLabel).toBe("Not picked up");
  });

  it("/session/start tells the assignee itself, which is what closes the loop", async () => {
    // The agent that never picked the task up is the one best placed to notice
    // on its next start, and it gets there without anything being delivered.
    const res = await app.inject({
      method: "GET", url: `/session/start?repoId=${repoId}`, headers: as(agentToken),
    });
    expect(res.statusCode).toBe(200);
    expect(labelOf(res.json().data.tasks, staleId)).toBe("Not picked up");
    expect(labelOf(res.json().data.tasks, freshId)).toBe("Starting");
  });
});

describe("the cap cannot hide the row this exists to show", () => {
  // An unstarted task has by definition the OLDEST updatedAt among an agent's
  // open rows, so a plain `order by updated_at desc` sorts it last and the cap
  // removes it first. The bundle would report a true taskCount and omit the one
  // row that needed reporting.
  let buriedId: string;

  beforeAll(async () => {
    buriedId = await makeTask("assigned", 60_000);
    // More fresh rows than SESSION_TASK_LIMIT (10) so the stale one is past the
    // cap on recency alone.
    for (let i = 0; i < 12; i++) await makeTask("assigned", 0);
  });

  it("/session/start returns the untouched task even though 12 newer ones outrank it", async () => {
    const res = await app.inject({
      method: "GET", url: `/session/start?repoId=${repoId}`, headers: as(agentToken),
    });
    const rows = res.json().data.tasks as Array<{ id: string; humanLabel: string }>;
    expect(rows.length).toBeLessThan(res.json().data.taskCount);
    expect(labelOf(rows, buriedId)).toBe("Not picked up");
  });

  it("GET /tasks honours the same order once a limit is asked for", async () => {
    const res = await app.inject({
      method: "GET", url: `/tasks?repoId=${repoId}&limit=3`, headers: ADMIN,
    });
    const rows = res.json().data;
    expect(rows.length).toBe(3);
    expect(res.json().meta.total).toBeGreaterThan(3);
    expect(labelOf(rows, buriedId)).toBe("Not picked up");
  });
});

describe("bookkeeping writes do not count as picking a task up", () => {
  it("opening a task's comments leaves the label alone", async () => {
    // GET /tasks/:id/comments lazily creates and links the comment thread. That
    // write used to stamp updatedAt, so the diagnostic move an orchestrator makes
    // on a suspicious task — read what the worker said — silenced the label for
    // another full threshold.
    const id = await makeTask("assigned", 60_000);

    const before = await app.inject({ method: "GET", url: `/tasks/${id}`, headers: ADMIN });
    expect(before.json().data.humanLabel).toBe("Not picked up");

    const comments = await app.inject({ method: "GET", url: `/tasks/${id}/comments`, headers: ADMIN });
    expect(comments.statusCode).toBe(200);
    expect(comments.json().data.threadId).toBeTruthy();

    const after = await app.inject({ method: "GET", url: `/tasks/${id}`, headers: ADMIN });
    expect(after.json().data.humanLabel).toBe("Not picked up");
  });
});
