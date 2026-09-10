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

// The premise the block above assumed and never checked: POST /agents was
// gated, the rotate and delete routes beside it were not.
describe("a worker cannot mint or destroy another agent's token", () => {
  let victimOrchId: string;

  beforeAll(async () => {
    const o = await app.inject({
      method: "POST", url: "/agents", headers: ADMIN,
      body: JSON.stringify({ repoId, name: "escalation-victim-orch", role: "orchestrator" }),
    });
    victimOrchId = o.json().data.id;
  });

  it("refuses a worker rotating another agent's token", async () => {
    const res = await app.inject({
      method: "POST", url: `/agents/${victimOrchId}/tokens`, headers: asAgent(workerToken),
    });
    expect(res.statusCode).toBe(403);
  });

  it("stops the escalation this enables: minting an orchestrator token and authoring a shell predicate with it", async () => {
    const rotate = await app.inject({
      method: "POST", url: `/agents/${victimOrchId}/tokens`, headers: asAgent(workerToken),
    });
    expect(rotate.statusCode).toBe(403);
    // If the rotate had succeeded, this call with the minted token would have
    // been the actual reachable-code-execution step. It must never run.
    const stolen = rotate.json().token as string | undefined;
    expect(stolen).toBeUndefined();
  });

  it("still allows an agent to rotate its own token", async () => {
    const w = await app.inject({
      method: "POST", url: "/agents", headers: ADMIN,
      body: JSON.stringify({ repoId, name: "self-rotate-worker", role: "worker" }),
    });
    const selfId = w.json().data.id;
    const selfToken = w.json().token;

    const res = await app.inject({
      method: "POST", url: `/agents/${selfId}/tokens`, headers: asAgent(selfToken),
    });
    expect(res.statusCode).toBe(201);
  });

  it("refuses a worker deleting another agent's registration", async () => {
    const res = await app.inject({
      method: "DELETE", url: `/agents/${victimOrchId}`, headers: asAgent(workerToken),
    });
    expect(res.statusCode).toBe(403);

    const still = await app.inject({ method: "GET", url: `/agents/${victimOrchId}`, headers: ADMIN });
    expect(still.statusCode).toBe(200);
  });

  it("lets an orchestrator rotate and delete another agent's token in its own repo", async () => {
    const rotate = await app.inject({
      method: "POST", url: `/agents/${victimOrchId}/tokens`, headers: asAgent(orchToken),
    });
    expect(rotate.statusCode).toBe(201);

    const del = await app.inject({
      method: "DELETE", url: `/agents/${victimOrchId}`, headers: asAgent(orchToken),
    });
    expect(del.statusCode).toBe(204);
  });

  it("still lets the admin path delete an agent", async () => {
    const a = await app.inject({
      method: "POST", url: "/agents", headers: ADMIN,
      body: JSON.stringify({ repoId, name: "admin-delete-target", role: "worker" }),
    });
    const targetId = a.json().data.id;

    const del = await app.inject({
      method: "DELETE", url: `/agents/${targetId}`, headers: ADMIN,
    });
    expect(del.statusCode).toBe(204);

    const gone = await app.inject({ method: "GET", url: `/agents/${targetId}`, headers: ADMIN });
    expect(gone.statusCode).toBe(404);
  });
});

// Same authority as rotation, on the route that undoes it. A worker revoking
// the orchestrator's active tokens is as much a lockout as minting a new one.
describe("a worker cannot revoke another agent's token", () => {
  it("refuses revocation, and the token still authenticates afterward", async () => {
    const o = await app.inject({
      method: "POST", url: "/agents", headers: ADMIN,
      body: JSON.stringify({ repoId, name: "revoke-victim-orch", role: "orchestrator" }),
    });
    const victimId = o.json().data.id;
    const victimToken = o.json().token;

    // GET /agents does not expose a token id; mint one this caller can target.
    const minted = await app.inject({
      method: "POST", url: `/agents/${victimId}/tokens`, headers: asAgent(victimToken),
    });
    const tokenId = minted.json().data.id as string;

    const revoke = await app.inject({
      method: "DELETE", url: `/tokens/${tokenId}`, headers: asAgent(workerToken),
    });
    expect(revoke.statusCode).toBe(403);

    const still = await app.inject({ method: "GET", url: "/health", headers: asAgent(victimToken) });
    expect(still.statusCode).not.toBe(401);
  });

  it("still lets the agent revoke its own token, and an orchestrator revoke another's", async () => {
    const w = await app.inject({
      method: "POST", url: "/agents", headers: ADMIN,
      body: JSON.stringify({ repoId, name: "self-revoke-worker", role: "worker" }),
    });
    const selfId = w.json().data.id;
    const selfToken = w.json().token;
    const minted = await app.inject({
      method: "POST", url: `/agents/${selfId}/tokens`, headers: asAgent(selfToken),
    });

    const selfRevoke = await app.inject({
      method: "DELETE", url: `/tokens/${minted.json().data.id}`, headers: asAgent(selfToken),
    });
    expect(selfRevoke.statusCode).toBe(204);

    const minted2 = await app.inject({
      method: "POST", url: `/agents/${selfId}/tokens`, headers: asAgent(orchToken),
    });
    const orchRevoke = await app.inject({
      method: "DELETE", url: `/tokens/${minted2.json().data.id}`, headers: asAgent(orchToken),
    });
    expect(orchRevoke.statusCode).toBe(204);
  });
});
