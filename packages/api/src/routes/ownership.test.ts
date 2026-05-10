// Cross-tenant isolation under the service-admin auth path. Two users own
// disjoint projects; each can only see and mutate their own. The legacy
// API_SECRET caller can still see everything (self-host parity).

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { buildServer } from "../server.js";
import { createDb, users, projects } from "@getrelai/db";
import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";

const DB_URL = process.env.DATABASE_URL ?? "postgresql://relai:relai@localhost:5433/relai";
const SECRET = "test-secret-ownership";
const SERVICE_TOKEN = "test-service-admin-ownership";

process.env.DATABASE_URL          = DB_URL;
process.env.API_SECRET            = SECRET;
process.env.SERVICE_ADMIN_TOKEN   = SERVICE_TOKEN;

const ADMIN = { Authorization: `Bearer ${SECRET}` };

let app: FastifyInstance;
const db = createDb(DB_URL);

const userA = "usr_test_A_" + Date.now();
const userB = "usr_test_B_" + Date.now();

// Projects + agents created during setup; tracked for teardown.
let projectAId: string;
let projectBId: string;
let agentAId: string;
let agentAToken: string;
let agentBId: string;
let agentBToken: string;

const adminHeaders = (extra?: Record<string, string>) => ({
  ...ADMIN,
  "Content-Type": "application/json",
  ...(extra ?? {}),
});

const serviceHeaders = (ownerId: string) => ({
  Authorization: `Bearer ${SERVICE_TOKEN}`,
  "X-Owner-Id": ownerId,
  "Content-Type": "application/json",
});

beforeAll(async () => {
  app = buildServer({ logger: false, scheduler: false });
  await app.ready();

  // Seed two tenants directly (closed cloud overlay's job in production; here
  // we stand in for it by writing the rows).
  await db.insert(users).values({ id: userA, email: `${userA}@test.local` });
  await db.insert(users).values({ id: userB, email: `${userB}@test.local` });

  // Tenant A creates its project via the service-admin path so ownerId is stamped.
  const pA = await app.inject({
    method: "POST", url: "/projects",
    headers: serviceHeaders(userA),
    body: JSON.stringify({ name: "tenant-A-project" }),
  });
  expect(pA.statusCode).toBe(201);
  projectAId = pA.json().data.id;
  expect(pA.json().data.ownerId).toBe(userA);

  const pB = await app.inject({
    method: "POST", url: "/projects",
    headers: serviceHeaders(userB),
    body: JSON.stringify({ name: "tenant-B-project" }),
  });
  expect(pB.statusCode).toBe(201);
  projectBId = pB.json().data.id;

  // One agent per tenant. Use admin auth so we get a token back to test the
  // per-agent-token path independently.
  const aA = await app.inject({
    method: "POST", url: "/agents",
    headers: adminHeaders(),
    body: JSON.stringify({ projectId: projectAId, name: "agent-A", role: "worker" }),
  });
  expect(aA.statusCode).toBe(201);
  agentAId = aA.json().data.id;
  agentAToken = aA.json().token;

  const aB = await app.inject({
    method: "POST", url: "/agents",
    headers: adminHeaders(),
    body: JSON.stringify({ projectId: projectBId, name: "agent-B", role: "worker" }),
  });
  expect(aB.statusCode).toBe(201);
  agentBId = aB.json().data.id;
  agentBToken = aB.json().token;
});

afterAll(async () => {
  if (projectAId) await app.inject({ method: "DELETE", url: `/projects/${projectAId}`, headers: ADMIN });
  if (projectBId) await app.inject({ method: "DELETE", url: `/projects/${projectBId}`, headers: ADMIN });
  await db.delete(users).where(eq(users.id, userA));
  await db.delete(users).where(eq(users.id, userB));
  await app?.close();
});

describe("ownership: project list scoping", () => {
  it("service-admin sees only its tenant's projects", async () => {
    const res = await app.inject({ method: "GET", url: "/projects", headers: serviceHeaders(userA) });
    expect(res.statusCode).toBe(200);
    const ids = res.json().data.map((p: { id: string }) => p.id);
    expect(ids).toContain(projectAId);
    expect(ids).not.toContain(projectBId);
  });

  it("API_SECRET caller sees both tenants' projects", async () => {
    const res = await app.inject({ method: "GET", url: "/projects", headers: ADMIN });
    expect(res.statusCode).toBe(200);
    const ids = res.json().data.map((p: { id: string }) => p.id);
    expect(ids).toContain(projectAId);
    expect(ids).toContain(projectBId);
  });

  it("per-agent caller sees only its own project", async () => {
    const res = await app.inject({
      method: "GET", url: "/projects",
      headers: { Authorization: `Bearer ${agentAToken}` },
    });
    expect(res.statusCode).toBe(200);
    const ids = res.json().data.map((p: { id: string }) => p.id);
    expect(ids).toEqual([projectAId]);
  });
});

describe("ownership: project detail/update/delete cross-tenant", () => {
  it("service-admin gets 404 for a project owned by another tenant", async () => {
    const res = await app.inject({
      method: "GET", url: `/projects/${projectBId}`,
      headers: serviceHeaders(userA),
    });
    expect(res.statusCode).toBe(404);
  });

  it("service-admin cannot update another tenant's project", async () => {
    const res = await app.inject({
      method: "PUT", url: `/projects/${projectBId}`,
      headers: serviceHeaders(userA),
      body: JSON.stringify({ name: "hijacked" }),
    });
    expect(res.statusCode).toBe(404);
  });

  it("service-admin cannot delete another tenant's project", async () => {
    const res = await app.inject({
      method: "DELETE", url: `/projects/${projectBId}`,
      headers: serviceHeaders(userA),
    });
    expect(res.statusCode).toBe(404);
  });

  it("per-agent caller is forbidden from another project", async () => {
    const res = await app.inject({
      method: "GET", url: `/projects/${projectBId}`,
      headers: { Authorization: `Bearer ${agentAToken}` },
    });
    expect(res.statusCode).toBe(403);
  });
});

describe("ownership: agents and tasks scoping", () => {
  it("service-admin sees only its tenant's agents", async () => {
    const res = await app.inject({ method: "GET", url: "/agents", headers: serviceHeaders(userA) });
    expect(res.statusCode).toBe(200);
    const ids = res.json().data.map((a: { id: string }) => a.id);
    expect(ids).toContain(agentAId);
    expect(ids).not.toContain(agentBId);
  });

  it("service-admin cannot create an agent under another tenant's project", async () => {
    const res = await app.inject({
      method: "POST", url: "/agents",
      headers: serviceHeaders(userA),
      body: JSON.stringify({ projectId: projectBId, name: "intruder", role: "worker" }),
    });
    expect(res.statusCode).toBe(404);
  });

  it("service-admin cannot create a task under another tenant's project", async () => {
    const res = await app.inject({
      method: "POST", url: "/tasks",
      headers: serviceHeaders(userA),
      body: JSON.stringify({
        projectId:   projectBId,
        createdBy:   agentAId,
        title:       "tenant-jump",
        description: "should never land",
      }),
    });
    expect(res.statusCode).toBe(404);
  });

  it("service-admin /tasks list is scoped to its tenant", async () => {
    // Seed a task in each project via API_SECRET.
    const tA = await app.inject({
      method: "POST", url: "/tasks",
      headers: adminHeaders(),
      body: JSON.stringify({ projectId: projectAId, createdBy: agentAId, title: "A-task", description: "x" }),
    });
    expect(tA.statusCode).toBe(201);
    const tB = await app.inject({
      method: "POST", url: "/tasks",
      headers: adminHeaders(),
      body: JSON.stringify({ projectId: projectBId, createdBy: agentBId, title: "B-task", description: "x" }),
    });
    expect(tB.statusCode).toBe(201);

    const list = await app.inject({ method: "GET", url: "/tasks", headers: serviceHeaders(userA) });
    expect(list.statusCode).toBe(200);
    const titles = list.json().data.map((t: { title: string }) => t.title);
    expect(titles).toContain("A-task");
    expect(titles).not.toContain("B-task");
  });
});

describe("ownership: legacy POST /projects without ownerId", () => {
  it("API_SECRET-created projects have null ownerId (self-host parity)", async () => {
    const res = await app.inject({
      method: "POST", url: "/projects",
      headers: adminHeaders(),
      body: JSON.stringify({ name: "self-hosted-project" }),
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().data.ownerId).toBeNull();

    // Cleanup
    const id = res.json().data.id;
    await app.inject({ method: "DELETE", url: `/projects/${id}`, headers: ADMIN });
  });
});
