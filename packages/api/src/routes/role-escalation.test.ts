import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { buildServer } from "../server.js";
import { createDb, invites } from "@getrelai/db";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";

const DB_URL = process.env.DATABASE_URL ?? "postgresql://relai:relai@localhost:5433/relai";
const SECRET = "test-secret-roles";

process.env.DATABASE_URL = DB_URL;
process.env.API_SECRET = SECRET;

const ADMIN = { Authorization: `Bearer ${SECRET}`, "Content-Type": "application/json" };
const asAgent = (token: string) => ({ Authorization: `Bearer ${token}`, "Content-Type": "application/json" });

let app: FastifyInstance;
let repoId: string;
let workerToken: string;
let orchToken: string;

beforeAll(async () => {
  app = buildServer({ logger: false, scheduler: false });
  await app.ready();

  const repo = await app.inject({
    method: "POST", url: "/repos", headers: ADMIN,
    body: JSON.stringify({ name: "__test__ roles" }),
  });
  repoId = repo.json().data.id;

  const w = await app.inject({
    method: "POST", url: "/agents", headers: ADMIN,
    body: JSON.stringify({ repoId, name: "role-worker", role: "worker" }),
  });
  workerToken = w.json().token;

  const o = await app.inject({
    method: "POST", url: "/agents", headers: ADMIN,
    body: JSON.stringify({ repoId, name: "role-orch", role: "orchestrator" }),
  });
  orchToken = o.json().token;
});

afterAll(async () => {
  if (repoId) await app.inject({ method: "DELETE", url: `/repos/${repoId}`, headers: ADMIN });
  await app?.close();
});

const newInvite = (headers: Record<string, string>, body: Record<string, unknown> = {}) =>
  app.inject({ method: "POST", url: `/repos/${repoId}/invites`, headers, body: JSON.stringify(body) });

const accept = (body: Record<string, unknown>) =>
  app.inject({
    method: "POST", url: "/auth/accept-invite",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

describe("POST /agents is not a self-service role dispenser", () => {
  it("refuses a worker token registering an agent", async () => {
    const res = await app.inject({
      method: "POST", url: "/agents", headers: asAgent(workerToken),
      body: JSON.stringify({ repoId, name: "minted-orch", role: "orchestrator" }),
    });

    expect(res.statusCode).toBe(403);
  });

  it("refuses a worker token even when asking only for a worker", async () => {
    const res = await app.inject({
      method: "POST", url: "/agents", headers: asAgent(workerToken),
      body: JSON.stringify({ repoId, name: "minted-worker", role: "worker" }),
    });

    expect(res.statusCode).toBe(403);
  });

  it("still allows an orchestrator token", async () => {
    const res = await app.inject({
      method: "POST", url: "/agents", headers: asAgent(orchToken),
      body: JSON.stringify({ repoId, name: "orch-made-this", role: "worker" }),
    });

    expect(res.statusCode).toBe(201);
  });

  it("still allows the admin path the seed scripts use", async () => {
    const res = await app.inject({
      method: "POST", url: "/agents", headers: ADMIN,
      body: JSON.stringify({ repoId, name: "admin-made-this", role: "worker" }),
    });

    expect(res.statusCode).toBe(201);
  });
});

describe("the invite pins the role, the accepter does not choose it", () => {
  it("defaults a new invite to worker", async () => {
    const res = await newInvite(ADMIN);
    expect(res.statusCode).toBe(201);

    const db = createDb(DB_URL);
    const [row] = await db.select().from(invites).where(eq(invites.id, res.json().data.id));
    expect(row.role).toBe("worker");
  });

  it("refuses a worker token minting an orchestrator invite", async () => {
    const res = await newInvite(asAgent(workerToken), { role: "orchestrator" });

    expect(res.statusCode).toBe(403);
  });

  it("lets an orchestrator mint an orchestrator invite", async () => {
    const res = await newInvite(asAgent(orchToken), { role: "orchestrator" });

    expect(res.statusCode).toBe(201);
    const db = createDb(DB_URL);
    const [row] = await db.select().from(invites).where(eq(invites.id, res.json().data.id));
    expect(row.role).toBe("orchestrator");
  });

  // The original escalation: redeem a worker invite while asking for orchestrator.
  it("refuses an accept that claims a role the invite did not grant", async () => {
    const inv = await newInvite(ADMIN);
    const res = await accept({ code: inv.json().code, name: "climber", role: "orchestrator" });

    expect(res.statusCode).toBe(403);
  });

  it("grants the invite's role when the accepter names it correctly", async () => {
    const inv = await newInvite(ADMIN);
    const res = await accept({ code: inv.json().code, name: "honest-worker", role: "worker" });

    expect(res.statusCode).toBe(201);
    expect(res.json().data.role).toBe("worker");
  });

  // What @getrelai/agent and `relai login` actually send.
  it("grants the invite's role when the accepter omits it", async () => {
    const inv = await newInvite(ADMIN);
    const res = await accept({ code: inv.json().code, name: "quiet-worker", workerType: "mcp" });

    expect(res.statusCode).toBe(201);
    expect(res.json().data.role).toBe("worker");
  });

  // Mutation testing gap: this is the only case where reading the body instead
  // of the invite diverges, and it is the path `relai login` now takes.
  it("grants orchestrator when the accepter omits the role on an orchestrator invite", async () => {
    const inv = await newInvite(ADMIN, { role: "orchestrator" });
    const res = await accept({ code: inv.json().code, name: "silent-orch", workerType: "human" });

    expect(res.statusCode).toBe(201);
    expect(res.json().data.role).toBe("orchestrator");
  });

  it("carries an orchestrator invite through to the registered agent", async () => {
    const inv = await newInvite(ADMIN, { role: "orchestrator" });
    const res = await accept({ code: inv.json().code, name: "real-orch", role: "orchestrator" });

    expect(res.statusCode).toBe(201);
    expect(res.json().data.role).toBe("orchestrator");
  });
});

describe("the shell-predicate gate is sound once roles cannot be self-granted", () => {
  const shellTask = (headers: Record<string, string>, name: string) =>
    app.inject({
      method: "POST", url: "/tasks", headers,
      body: JSON.stringify({
        repoId, createdBy: name, title: "shell gated", description: "x",
        verifyKind: "shell", verifyCommand: "true",
      }),
    });

  it("still refuses a worker authoring a shell predicate", async () => {
    const res = await shellTask(asAgent(workerToken), "w");
    expect(res.statusCode).toBe(403);
  });

  // Deliberately still permitted: with self-assignment closed, orchestrator is a
  // role only an admin or owner can grant, so this gate holds. Tightening it to
  // owner-only belongs with the org/members work, when orchestrator stops being
  // a small trusted set.
  it("still allows an orchestrator authoring a shell predicate", async () => {
    const res = await shellTask(asAgent(orchToken), "o");
    expect(res.statusCode).toBe(201);
  });
});
