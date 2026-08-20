import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { buildServer, BODY_LIMIT_BYTES } from "../server.js";
import type { FastifyInstance } from "fastify";

const DB_URL = process.env.DATABASE_URL ?? "postgresql://relai:relai@localhost:5433/relai";
const SECRET = "test-secret-bodylimit";

process.env.DATABASE_URL = DB_URL;
process.env.API_SECRET = SECRET;

const ADMIN = { Authorization: `Bearer ${SECRET}`, "Content-Type": "application/json" };

let app: FastifyInstance;
let repoId: string;

beforeAll(async () => {
  app = buildServer({ logger: false, scheduler: false });
  await app.ready();
  const repo = await app.inject({
    method: "POST", url: "/repos", headers: ADMIN, body: JSON.stringify({ name: "__test__ bodylimit" }),
  });
  repoId = repo.json().data.id;
});

afterAll(async () => {
  if (repoId) await app.inject({ method: "DELETE", url: `/repos/${repoId}`, headers: ADMIN });
  await app?.close();
});

describe("request body limit", () => {
  it("accepts a realistically large task description", async () => {
    // Comfortably bigger than anything the workers write, well under the cap.
    const res = await app.inject({
      method: "POST", url: "/tasks", headers: ADMIN,
      body: JSON.stringify({ repoId, createdBy: "human", title: "big", description: "x".repeat(64 * 1024) }),
    });

    expect(res.statusCode).toBe(201);
  });

  it("rejects a body past the limit with 413, not a 500 or a truncated write", async () => {
    const res = await app.inject({
      method: "POST", url: "/tasks", headers: ADMIN,
      body: JSON.stringify({ repoId, createdBy: "human", title: "huge", description: "x".repeat(BODY_LIMIT_BYTES + 1024) }),
    });

    expect(res.statusCode).toBe(413);
  });
});
