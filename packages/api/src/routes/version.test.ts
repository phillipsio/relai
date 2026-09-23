// Production ran two commits behind main for four days with a security fix
// merged and believed live, and nothing served by the API could have revealed
// it: /health returned {ok:true} and there was no version route at all. The
// only way to answer "what is actually running" was ssh onto the box.
//
// The commit goes on AUTHENTICATED /health and deliberately NOT on the public
// /livez. This repo is public, so a bare sha tells an unauthenticated caller
// exactly which published source is running and therefore which known gaps are
// still open — on the night this was written, it would have advertised that
// rotation did not yet revoke.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { buildServer } from "../server.js";
import { deployedCommit } from "../lib/version.js";
import type { FastifyInstance } from "fastify";

const DB_URL = process.env.DATABASE_URL ?? "postgresql://relai:relai@localhost:5433/relai";
const SECRET = "test-secret-version";

process.env.DATABASE_URL = DB_URL;
process.env.API_SECRET = SECRET;

const ADMIN = { Authorization: `Bearer ${SECRET}` };

let app: FastifyInstance;

beforeAll(async () => {
  app = buildServer({ logger: false, scheduler: false });
  await app.ready();
});

afterAll(async () => {
  await app?.close();
});

describe("the API can say what is running", () => {
  it("reports a commit on authenticated /health", async () => {
    const res = await app.inject({ method: "GET", url: "/health", headers: ADMIN });
    expect(res.statusCode).toBe(200);

    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body).toHaveProperty("commit");
    // Unknown is a legitimate answer off a checkout; a wrong answer is not.
    if (body.commit !== null) expect(body.commit).toMatch(/^[0-9a-f]{7,40}$/);
  });

  it("reads it from this working tree, so a deploy that is a git pull is enough", () => {
    const commit = deployedCommit();
    if (commit === null) return;
    expect(commit).toMatch(/^[0-9a-f]{7,40}$/);
  });

  it("does not leak the commit to the unauthenticated probe", async () => {
    const res = await app.inject({ method: "GET", url: "/livez" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    expect(res.body).not.toContain("commit");
  });

  it("still refuses /health without a token, so the commit is not readable anonymously", async () => {
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(401);
    expect(res.body).not.toContain("commit");
  });
});
