import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { buildServer } from "../server.js";
import type { FastifyInstance } from "fastify";

const DB_URL = process.env.DATABASE_URL ?? "postgresql://relai:relai@localhost:5433/relai";
const SECRET = "test-secret-invites";

process.env.DATABASE_URL = DB_URL;
process.env.API_SECRET   = SECRET;

const ADMIN = { Authorization: `Bearer ${SECRET}`, "Content-Type": "application/json" };

let app: FastifyInstance;
let projectId: string;

beforeAll(async () => {
  app = buildServer({ logger: false, scheduler: false });
  await app.ready();

  const project = await app.inject({
    method: "POST", url: "/projects", headers: ADMIN,
    body: JSON.stringify({ name: "__test__ invites" }),
  });
  expect(project.statusCode).toBe(201);
  projectId = project.json().data.id;
});

afterAll(async () => {
  if (projectId) {
    await app.inject({ method: "DELETE", url: `/projects/${projectId}`, headers: ADMIN });
  }
  await app?.close();
});

describe("POST /projects/:id/invites", () => {
  it("returns a one-time invite code", async () => {
    const res = await app.inject({
      method: "POST", url: `/projects/${projectId}/invites`, headers: ADMIN,
      body: JSON.stringify({ suggestedName: "alice-claude", suggestedSpecialization: "writer" }),
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().code).toMatch(/^inv_/);
    expect(res.json().data.id).toMatch(/^invite_/);
    expect(res.json().data.suggestedName).toBe("alice-claude");
  });

  it("rejects creation for unknown project", async () => {
    const res = await app.inject({
      method: "POST", url: "/projects/proj_nonexistent/invites", headers: ADMIN,
      body: JSON.stringify({}),
    });
    expect(res.statusCode).toBe(404);
  });
});

describe("POST /auth/accept-invite", () => {
  let inviteCode: string;
  let inviteId: string;

  beforeAll(async () => {
    const res = await app.inject({
      method: "POST", url: `/projects/${projectId}/invites`, headers: ADMIN,
      body: JSON.stringify({}),
    });
    inviteCode = res.json().code;
    inviteId = res.json().data.id;
  });

  it("works without a bearer token", async () => {
    const res = await app.inject({
      method: "POST", url: "/auth/accept-invite",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: inviteCode, name: "alice-claude", role: "worker" }),
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.data.id).toMatch(/^agent_/);
    expect(body.data.projectId).toBe(projectId);
    expect(body.data.name).toBe("alice-claude");
    expect(body.token).toMatch(/^aio_/);
  });

  it("rejects re-use of an accepted invite code", async () => {
    const res = await app.inject({
      method: "POST", url: "/auth/accept-invite",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: inviteCode, name: "alice2", role: "worker" }),
    });
    expect(res.statusCode).toBe(400);
  });

  it("rejects unknown invite codes", async () => {
    const res = await app.inject({
      method: "POST", url: "/auth/accept-invite",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: "inv_doesnotexist", name: "ghost", role: "worker" }),
    });
    expect(res.statusCode).toBe(400);
  });

  it("rejects revoked invites", async () => {
    const create = await app.inject({
      method: "POST", url: `/projects/${projectId}/invites`, headers: ADMIN,
      body: JSON.stringify({}),
    });
    const code = create.json().code;
    const id   = create.json().data.id;

    const revoke = await app.inject({ method: "DELETE", url: `/invites/${id}`, headers: ADMIN });
    expect(revoke.statusCode).toBe(204);

    const accept = await app.inject({
      method: "POST", url: "/auth/accept-invite",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code, name: "revoked-test", role: "worker" }),
    });
    expect(accept.statusCode).toBe(400);

    // Silence unused-var lint on inviteId from the outer scope.
    void inviteId;
  });

  it("rejects expired invites", async () => {
    const create = await app.inject({
      method: "POST", url: `/projects/${projectId}/invites`, headers: ADMIN,
      body: JSON.stringify({ ttlSeconds: 1 }),
    });
    const code = create.json().code;

    await new Promise((r) => setTimeout(r, 1100));

    const accept = await app.inject({
      method: "POST", url: "/auth/accept-invite",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code, name: "expired-test", role: "worker" }),
    });
    expect(accept.statusCode).toBe(400);
  });
});

describe("GET /projects/:id/invites", () => {
  it("lists invites for the project", async () => {
    const res = await app.inject({
      method: "GET", url: `/projects/${projectId}/invites`, headers: ADMIN,
    });
    expect(res.statusCode).toBe(200);
    const data = res.json().data as Array<{ projectId: string }>;
    expect(data.length).toBeGreaterThan(0);
    expect(data.every((i) => i.projectId === projectId)).toBe(true);
  });
});
