import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { buildServer, BODY_LIMIT_BYTES } from "../server.js";
import type { FastifyInstance } from "fastify";

const DB_URL = process.env.DATABASE_URL ?? "postgresql://relai:relai@localhost:5433/relai";
const SECRET = "test-secret-emptybody";

process.env.DATABASE_URL = DB_URL;
process.env.API_SECRET = SECRET;

// Every client we ship (CLI, MCP server, dashboard, both workers) sets this
// header on every request, including ones with no body at all.
const ADMIN = { Authorization: `Bearer ${SECRET}`, "Content-Type": "application/json" };

let app: FastifyInstance;
let repoId: string;

beforeAll(async () => {
  app = buildServer({ logger: false, scheduler: false });
  await app.ready();
  const repo = await app.inject({
    method: "POST", url: "/repos", headers: ADMIN, body: JSON.stringify({ name: "__test__ emptybody" }),
  });
  repoId = repo.json().data.id;
});

afterAll(async () => {
  if (repoId) await app.inject({ method: "DELETE", url: `/repos/${repoId}`, headers: ADMIN });
  await app?.close();
});

describe("a JSON content-type with no body", () => {
  it("is accepted on DELETE, which carries no payload", async () => {
    const sub = await app.inject({
      method: "POST", url: "/subscriptions", headers: ADMIN,
      body: JSON.stringify({ agentId: "agent_missing", targetType: "repo", targetId: repoId }),
    });
    // The route may reject the fake agent; the point is only that a bodyless
    // DELETE reaches the handler rather than dying in the parser.
    const id = sub.statusCode === 201 ? sub.json().data.id : "sub_missing";

    const res = await app.inject({ method: "DELETE", url: `/subscriptions/${id}`, headers: ADMIN });

    expect(res.statusCode).not.toBe(400);
  });

  it("is accepted on a PUT whose route takes no payload", async () => {
    const res = await app.inject({ method: "PUT", url: "/threads/thread_missing/archive", headers: ADMIN });

    expect(res.statusCode).not.toBe(400);
  });

  it("is matched when the header carries a charset parameter", async () => {
    const res = await app.inject({
      method: "POST", url: "/repos",
      headers: { Authorization: `Bearer ${SECRET}`, "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({ name: "__test__ charset" }),
    });

    expect(res.statusCode).toBe(201);
    await app.inject({ method: "DELETE", url: `/repos/${res.json().data.id}`, headers: ADMIN });
  });

  it("still rejects a malformed body, so the tolerance is for empty and nothing else", async () => {
    const res = await app.inject({
      method: "POST", url: "/repos", headers: ADMIN, body: "{ not json",
    });

    expect(res.statusCode).toBe(400);
  });

  it("still enforces the body limit", async () => {
    const res = await app.inject({
      method: "POST", url: "/tasks", headers: ADMIN,
      body: JSON.stringify({ repoId, createdBy: "human", title: "huge", description: "x".repeat(BODY_LIMIT_BYTES + 1024) }),
    });

    expect(res.statusCode).toBe(413);
  });
});
