import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { buildServer } from "../server.js";
import type { FastifyInstance } from "fastify";

const DB_URL = process.env.DATABASE_URL ?? "postgresql://relai:relai@localhost:5433/relai";
const SECRET = "test-secret-auth";

process.env.DATABASE_URL = DB_URL;
process.env.API_SECRET   = SECRET;

const ADMIN = { Authorization: `Bearer ${SECRET}` };

let app: FastifyInstance;
let projectId: string;
let agentId: string;
let plaintextToken: string;

beforeAll(async () => {
  app = buildServer({ logger: false, scheduler: false });
  await app.ready();

  const project = await app.inject({
    method: "POST", url: "/projects",
    headers: { ...ADMIN, "Content-Type": "application/json" },
    body: JSON.stringify({ name: "__test__ auth" }),
  });
  expect(project.statusCode).toBe(201);
  projectId = project.json().data.id;

  const agent = await app.inject({
    method: "POST", url: "/agents",
    headers: { ...ADMIN, "Content-Type": "application/json" },
    body: JSON.stringify({ projectId, name: "auth-test-agent", role: "worker" }),
  });
  expect(agent.statusCode).toBe(201);
  agentId = agent.json().data.id;
  plaintextToken = agent.json().token;
  expect(plaintextToken).toMatch(/^aio_/);
});

afterAll(async () => {
  if (projectId) {
    await app.inject({ method: "DELETE", url: `/projects/${projectId}`, headers: ADMIN });
  }
  await app?.close();
});

describe("auth: per-agent tokens", () => {
  it("accepts a valid agent token and resolves request.agent", async () => {
    const res = await app.inject({
      method: "GET", url: `/agents/${agentId}`,
      headers: { Authorization: `Bearer ${plaintextToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.id).toBe(agentId);
  });

  it("rejects a syntactically valid but unknown token", async () => {
    const res = await app.inject({
      method: "GET", url: "/agents",
      headers: { Authorization: "Bearer aio_unknownnonsense" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("still accepts the legacy API_SECRET (fallback)", async () => {
    const res = await app.inject({ method: "GET", url: "/agents", headers: ADMIN });
    expect(res.statusCode).toBe(200);
  });

  it("rejects requests with no Authorization header", async () => {
    const res = await app.inject({ method: "GET", url: "/agents" });
    expect(res.statusCode).toBe(401);
  });
});

describe("auth: token rotate + revoke", () => {
  let secondToken: string;
  let secondTokenId: string;

  it("POST /agents/:id/tokens issues an additional token", async () => {
    const res = await app.inject({
      method: "POST", url: `/agents/${agentId}/tokens`,
      headers: { ...ADMIN, "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.statusCode).toBe(201);
    secondToken = res.json().token;
    secondTokenId = res.json().data.id;
    expect(secondToken).toMatch(/^aio_/);
    expect(secondToken).not.toBe(plaintextToken);
  });

  it("the new token authenticates", async () => {
    const res = await app.inject({
      method: "GET", url: `/agents/${agentId}`,
      headers: { Authorization: `Bearer ${secondToken}` },
    });
    expect(res.statusCode).toBe(200);
  });

  it("DELETE /tokens/:id revokes a token", async () => {
    const res = await app.inject({
      method: "DELETE", url: `/tokens/${secondTokenId}`,
      headers: ADMIN,
    });
    expect(res.statusCode).toBe(204);
  });

  it("a revoked token is rejected", async () => {
    const res = await app.inject({
      method: "GET", url: `/agents/${agentId}`,
      headers: { Authorization: `Bearer ${secondToken}` },
    });
    expect(res.statusCode).toBe(401);
  });

  it("the original token still works after sibling revoke", async () => {
    const res = await app.inject({
      method: "GET", url: `/agents/${agentId}`,
      headers: { Authorization: `Bearer ${plaintextToken}` },
    });
    expect(res.statusCode).toBe(200);
  });
});
