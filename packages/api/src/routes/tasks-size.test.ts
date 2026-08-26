import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { buildServer } from "../server.js";
import type { FastifyInstance } from "fastify";

const DB_URL = process.env.DATABASE_URL ?? "postgresql://relai:relai@localhost:5433/relai";
const SECRET = "test-secret-tasks-size";
process.env.DATABASE_URL = DB_URL;
process.env.API_SECRET = SECRET;

const ADMIN = { Authorization: `Bearer ${SECRET}`, "Content-Type": "application/json" };
const LONG = "d".repeat(5000);
const TASK_COUNT = 30;

let app: FastifyInstance;
let repoId: string, agentId: string;
let auth: { Authorization: string };

const list = async (qs = "") => {
  const res = await app.inject({ method: "GET", url: `/tasks?repoId=${repoId}${qs}`, headers: auth });
  expect(res.statusCode).toBe(200);
  return res.json();
};

beforeAll(async () => {
  app = buildServer({ logger: false, scheduler: false });
  await app.ready();

  const p = await app.inject({ method: "POST", url: "/repos", headers: ADMIN, body: JSON.stringify({ name: "__test__ tasks size" }) });
  repoId = p.json().data.id;
  const a = await app.inject({
    method: "POST", url: "/agents", headers: ADMIN, body: JSON.stringify({ repoId, name: "tasks-size-agent", role: "worker" }),
  });
  agentId = a.json().data.id;
  auth = { Authorization: `Bearer ${a.json().token}` };

  for (let i = 0; i < TASK_COUNT; i++) {
    await app.inject({
      method: "POST", url: "/tasks", headers: ADMIN,
      body: JSON.stringify({
        repoId, title: `task ${i}`, description: `body ${i} ${LONG}`, createdBy: "human",
        metadata: { files: Array.from({ length: 30 }, (_, n) => `src/some/long/path/file-${n}.ts`) },
      }),
    });
  }
});

afterAll(async () => {
  if (repoId) await app.inject({ method: "DELETE", url: `/repos/${repoId}`, headers: ADMIN });
  await app?.close();
});

describe("GET /tasks can be bounded", () => {
  it("always reports the true total, so a caller can tell it did not see everything", async () => {
    const body = await list();
    expect(body.meta.total).toBe(TASK_COUNT);
    expect(body.meta.returned).toBe(TASK_COUNT);
  });

  it("caps rows when limit is given, and still reports the full total", async () => {
    const body = await list("&limit=5");
    expect(body.data).toHaveLength(5);
    expect(body.meta.returned).toBe(5);
    expect(body.meta.total).toBe(TASK_COUNT);
  });

  it("clips descriptions and declares it, rather than clipping silently", async () => {
    const body = await list("&clip=true&limit=3");
    for (const t of body.data) {
      expect(t.description.length).toBeLessThan(1000);
      expect(t.truncated).toBe(true);
      expect(t.descriptionLength).toBeGreaterThan(5000);
    }
  });

  it("cuts an oversized payload to a fraction of its unbounded size", async () => {
    // The reported bug: the unfiltered call was 355k chars and blew past the
    // MCP client's token limit. Clipping is the bigger lever of the two because
    // it keeps every row.
    const unbounded = JSON.stringify(await list()).length;
    const clipped = JSON.stringify(await list("&clip=true")).length;
    expect(unbounded).toBeGreaterThan(100_000);
    expect(clipped).toBeLessThan(unbounded / 2);
  });

  it("clip alone keeps every row — it's a size lever, not a cap", async () => {
    const body = await list("&clip=true");
    expect(body.data).toHaveLength(TASK_COUNT);
    expect(body.data.every((t: { truncated?: boolean }) => t.truncated)).toBe(true);
  });

  it("returns newest-updated first so a cap takes the freshest rows", async () => {
    const body = await list("&limit=10");
    const times = body.data.map((t: { updatedAt: string }) => new Date(t.updatedAt).getTime());
    expect(times).toEqual([...times].sort((a, b) => b - a));
  });

  it("leaves unbounded callers alone — no limit means every row, unclipped", async () => {
    // The dashboard renders descriptions straight from this list and
    // attention-check diffs the whole set; defaulting to a cap would break both.
    const body = await list();
    expect(body.data).toHaveLength(TASK_COUNT);
    expect(body.data[0].description.length).toBeGreaterThan(5000);
    expect(body.data[0].truncated).toBeUndefined();
  });

  it("clamps a present-but-unparseable limit to the cap, never to unbounded", async () => {
    // A caller who asked to be bounded and got the value wrong must land on
    // the safe cap, not fall through to the exact unbounded response this
    // endpoint exists to prevent. Lowered TASKS_MAX_LIMIT makes the clamp
    // observable — with the default 200 and 30 rows, any cap looks the same
    // as unbounded.
    process.env.TASKS_MAX_LIMIT = "4";
    try {
      for (const bad of ["0", "-4", "abc", ""]) {
        const body = await list(`&limit=${bad}`);
        expect(body.data).toHaveLength(4);
      }
    } finally {
      delete process.env.TASKS_MAX_LIMIT;
    }
  });

  it("clamps an absurd limit instead of honouring it", async () => {
    // Lowered below the row count so the clamp is actually observable — with
    // the default cap of 200 and 30 rows, any limit at all looks identical.
    process.env.TASKS_MAX_LIMIT = "4";
    try {
      expect((await list("&limit=999999")).data).toHaveLength(4);
      expect((await list("&limit=2")).data).toHaveLength(2);
    } finally {
      delete process.env.TASKS_MAX_LIMIT;
    }
    expect((await list("&limit=999999")).data).toHaveLength(TASK_COUNT);
  });
});
