import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

// Module-wide, hence its own file: mocking claudeRouting inside
// scheduler.test.ts also broke the unblock path, which needs real routing.
vi.mock("./claude.js", () => ({
  claudeRouting: vi.fn(async () => ({ agentId: "UNROUTABLE", method: "claude", rationale: "no fit" })),
}));

import { buildServer } from "../../server.js";
import { routePendingTasks } from "./scheduler.js";
import { createDb } from "@getrelai/db";
import type { FastifyInstance } from "fastify";

const DB_URL = process.env.DATABASE_URL ?? "postgresql://relai:relai@localhost:5433/relai";
const SECRET = "test-secret-unroutable";
process.env.DATABASE_URL = DB_URL;
process.env.API_SECRET   = SECRET;

const ADMIN = { Authorization: `Bearer ${SECRET}`, "Content-Type": "application/json" };

const db = createDb(DB_URL);

let app: FastifyInstance;
let repoId: string;

// scheduler:false matters: the default loop ticks over EVERY repo in
// relai_test and races sibling forks' reap assertions.
beforeAll(async () => {
  app = await buildServer({ logger: false, scheduler: false });
  await app.ready();
});

afterAll(async () => {
  if (repoId) await app.inject({ method: "DELETE", url: `/repos/${repoId}`, headers: ADMIN });
  await app?.close();
});

describe("routePendingTasks: the unroutable branch that fires when a key IS set", () => {
  it("logs the unroutable verdict once per task, not once per tick", async () => {
    const repo = await app.inject({
      method: "POST", url: "/repos", headers: ADMIN,
      body: JSON.stringify({ name: "__test__ route-unroutable-once" }),
    });
    repoId = repo.json().data.id;

    const w = await app.inject({
      method: "POST", url: "/agents", headers: ADMIN,
      body: JSON.stringify({ repoId, name: "u-writer", role: "worker", specialization: "writer" }),
    });
    const wId = w.json().data.id;

    await app.inject({
      method: "POST", url: "/tasks", headers: ADMIN,
      body: JSON.stringify({
        repoId, createdBy: wId, title: "unroutable", description: "x",
        assignedTo: "@auto", specialization: "nobody-has-this",
      }),
    });

    const prevKey = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = "sk-test-not-used";
    const warns: string[] = [];
    const spy = vi.spyOn(console, "warn").mockImplementation((m?: unknown) => { warns.push(String(m)); });
    try {
      await routePendingTasks(db, repoId);
      await routePendingTasks(db, repoId);
      await routePendingTasks(db, repoId);
      expect(warns.filter((l) => l.includes("unroutable"))).toHaveLength(1);
    } finally {
      spy.mockRestore();
      if (prevKey === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = prevKey;
    }
  });
});
