// Production ran two commits behind main for four days with a security fix
// merged and believed live, and nothing the API served could have revealed it:
// /health returned {ok:true} and there was no version route at all.
//
// The commit goes on AUTHENTICATED /health and deliberately NOT on the public
// /livez. This repo is public, so a bare sha tells an unauthenticated caller
// exactly which published source is running and therefore which known gaps are
// still open — on the night this was written, it would have advertised that
// rotation did not yet revoke.
//
// Every assertion here is unconditional. An earlier version guarded each one
// with `if (commit !== null)`, which meant a build returning null for every
// caller passed the whole file inside a real checkout: the tests pinned nothing.
// Seeding RELAI_COMMIT is what makes the answer knowable on any machine.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";

const DB_URL = process.env.DATABASE_URL ?? "postgresql://relai:relai@localhost:5433/relai";
const SECRET = "test-secret-version";
const SEEDED = "abc1234";

process.env.DATABASE_URL = DB_URL;
process.env.API_SECRET = SECRET;
// Before the import below, because version.ts resolves once at module load.
process.env.RELAI_COMMIT = SEEDED;

const ADMIN = { Authorization: `Bearer ${SECRET}` };

let app: FastifyInstance;
let deployedCommit: () => string | null;

beforeAll(async () => {
  // Imported here rather than at the top so RELAI_COMMIT above is already set:
  // version.ts resolves once at module load, which is the property under test.
  const { buildServer } = await import("../server.js");
  ({ deployedCommit } = await import("../lib/version.js"));
  app = buildServer({ logger: false, scheduler: false });
  await app.ready();
});

afterAll(async () => {
  await app?.close();
});

describe("the API can say what is running", () => {
  it("returns exactly ok and the commit on authenticated /health", async () => {
    const res = await app.inject({ method: "GET", url: "/health", headers: ADMIN });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, commit: SEEDED });
  });

  it("takes RELAI_COMMIT over the checkout, for deploys that are not one", () => {
    expect(deployedCommit()).toBe(SEEDED);
  });

  it("does not leak the commit to the unauthenticated probe", async () => {
    const res = await app.inject({ method: "GET", url: "/livez" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    expect(res.body).not.toContain(SEEDED);
  });

  it("still refuses /health without a token, so the commit is not readable anonymously", async () => {
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(401);
    expect(res.body).not.toContain(SEEDED);
  });

  it("is frozen at module load, so a later RELAI_COMMIT cannot change the answer", () => {
    const prev = process.env.RELAI_COMMIT;
    process.env.RELAI_COMMIT = "deadbee";
    try {
      // The point of resolving once: the value describes the code this process
      // loaded, not whatever the environment or the checkout says later.
      expect(deployedCommit()).toBe(SEEDED);
    } finally {
      process.env.RELAI_COMMIT = prev;
    }
  });
});
