// The owner agent provisioning its own work: create a repo, invite an agent
// into it, have that agent arrive.
//
// task_xixnN7JMPR1qeCzDNwPy6 says "the API side already works, which is what
// makes this small". That was read off the routes, not run, and the caller it
// was read for was the dashboard path (SERVICE_ADMIN_TOKEN + X-Owner-Id). The
// caller in production is a different shape: an owner-scoped AGENT token, which
// carries BOTH request.agent and request.ownerId, and several gates branch on
// request.agent first. So this drives the real one.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { buildServer } from "../server.js";
import { createDb, tokens, users, repos } from "@getrelai/db";
import { eq } from "drizzle-orm";
import { hashToken } from "../lib/tokens.js";
import type { FastifyInstance } from "fastify";

const DB_URL = process.env.DATABASE_URL ?? "postgresql://relai:relai@localhost:5433/relai";
const SECRET = "test-secret-owner-prov";
const SERVICE = "test-service-admin-owner-prov";

process.env.DATABASE_URL = DB_URL;
process.env.API_SECRET = SECRET;
process.env.SERVICE_ADMIN_TOKEN = SERVICE;

const ADMIN = { Authorization: `Bearer ${SECRET}`, "Content-Type": "application/json" };
const asOwner = (owner: string) => ({
  Authorization: `Bearer ${SERVICE}`,
  "X-Owner-Id": owner,
  "Content-Type": "application/json",
});
const as = (t: string) => ({ Authorization: `Bearer ${t}`, "Content-Type": "application/json" });

const db = createDb(DB_URL);
let app: FastifyInstance;

const ownerA = `usr_prov_a_${Date.now()}`;
const ownerB = `usr_prov_b_${Date.now()}`;
let homeRepo: string;      // owner A's starter repo
let otherOwnerRepo: string; // owner B's, which A must not reach
let ownerAgent: string;
let ownerToken: string;    // owner-scoped AGENT token — the production caller
let workerToken: string;   // ordinary repo-scoped token in the same repo
let provisioned: string;   // a second repo owner A owns, created in beforeAll
let mk: (name: string, owner: string) => Promise<string>;
const created: string[] = [];

beforeAll(async () => {
  app = buildServer({ logger: false, scheduler: false });
  await app.ready();

  await db.insert(users).values([
    { id: ownerA, email: `${ownerA}@test.invalid` },
    { id: ownerB, email: `${ownerB}@test.invalid` },
  ]);

  mk = async (name: string, owner: string) => {
    const r = await app.inject({
      method: "POST", url: "/repos", headers: asOwner(owner), body: JSON.stringify({ name }),
    });
    return r.json().data.id as string;
  };
  homeRepo       = await mk("__test__ prov home", ownerA);
  otherOwnerRepo = await mk("__test__ prov other", ownerB);

  const a = await app.inject({
    method: "POST", url: "/agents", headers: ADMIN,
    body: JSON.stringify({ repoId: homeRepo, name: "prov-owner-agent", role: "orchestrator" }),
  });
  ownerAgent = a.json().data.id;

  ownerToken = "aio_prov_owner_scoped_token";
  await db.insert(tokens).values({
    id: `tok_prov_${Date.now()}`,
    agentId: ownerAgent,
    ownerId: ownerA,
    tokenHash: hashToken(ownerToken),
  });

  const w = await app.inject({
    method: "POST", url: "/agents", headers: ADMIN,
    body: JSON.stringify({ repoId: homeRepo, name: "prov-worker", role: "worker" }),
  });
  workerToken = w.json().token;

  // Created here, not by the first test. Depending on test order left
  // `created[0]` undefined under `vitest -t`, so the request went to
  // /repos/undefined/invites and assertRepoAccess returned 403 "Repo not
  // found" — the same status the role guard returns, so the guard test passed
  // green without ever reaching the guard.
  provisioned = await mk("__test__ prov target", ownerA);
});

afterAll(async () => {
  for (const id of [...created, provisioned, homeRepo, otherOwnerRepo]) {
    if (id) await app.inject({ method: "DELETE", url: `/repos/${id}`, headers: ADMIN });
  }
  await db.delete(users).where(eq(users.id, ownerA));
  await db.delete(users).where(eq(users.id, ownerB));
  await app?.close();
});

describe("the owner agent can bring a project into existence", () => {
  it("creates a repo that is owned by the user, not orphaned", async () => {
    // ownerId comes from the token row. If it landed null the repo would be
    // invisible to every other credential this user holds, including the
    // dashboard's, which is a worse outcome than a refusal.
    const res = await app.inject({
      method: "POST", url: "/repos", headers: as(ownerToken),
      body: JSON.stringify({ name: "__test__ prov created", description: "made by the owner agent" }),
    });
    expect(res.statusCode).toBe(201);
    const id = res.json().data.id as string;
    created.push(id);

    const [row] = await db.select({ ownerId: repos.ownerId }).from(repos).where(eq(repos.id, id));
    expect(row.ownerId).toBe(ownerA);
  });

  it("and reaches it immediately afterwards, with no re-auth", async () => {
    const list = await app.inject({ method: "GET", url: "/repos", headers: as(ownerToken) });
    expect((list.json().data as Array<{ id: string }>).map((r) => r.id)).toEqual(
      expect.arrayContaining([homeRepo, created[0]]),
    );
  });
});

describe("inviting an agent, which is where the credential must NOT be", () => {
  it("mints an invite into a repo the owner owns but the agent does not live in", async () => {
    // The whole point: the owner agent's home is homeRepo, and it is
    // provisioning into a repo it created. Repo membership does not cover this;
    // owner scope does.
    const res = await app.inject({
      method: "POST", url: `/repos/${created[0]}/invites`, headers: as(ownerToken),
      body: JSON.stringify({ suggestedName: "tester", suggestedSpecialization: "testing", role: "worker" }),
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().code).toBeTruthy();
    expect(res.json().data.codeHash).toBeUndefined();
  });

  it("returns the code beside data, not inside it, which the client has to honour", async () => {
    const res = await app.inject({
      method: "POST", url: `/repos/${created[0]}/invites`, headers: as(ownerToken),
      body: JSON.stringify({ suggestedName: "shape-check" }),
    });
    const body = res.json();
    expect(body.code).toBeTruthy();
    expect(body.data.code).toBeUndefined();
  });

  it("the invited agent arrives in the right repo with the pinned identity", async () => {
    const mint = await app.inject({
      method: "POST", url: `/repos/${created[0]}/invites`, headers: as(ownerToken),
      body: JSON.stringify({ suggestedName: "arrives", suggestedSpecialization: "review", role: "worker" }),
    });
    const code = mint.json().code as string;

    const join = await app.inject({
      method: "POST", url: "/auth/accept-invite", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "arrives", code, workerType: "cursor" }),
    });
    expect(join.statusCode).toBe(201);
    expect(join.json().data.repoId).toBe(created[0]);
    expect(join.json().data.role).toBe("worker");
    expect(join.json().data.workerType).toBe("cursor");
    expect(join.json().token).toBeTruthy();
  });

  it("the new agent's own token is repo-scoped, so provisioning does not spread owner scope", async () => {
    // An owner-scoped agent minting invites must not hand out owner scope. The
    // invite carries ownerId only when device-auth set it, and this path does not.
    const mint = await app.inject({
      method: "POST", url: `/repos/${created[0]}/invites`, headers: as(ownerToken),
      body: JSON.stringify({ suggestedName: "scoped" }),
    });
    const join = await app.inject({
      method: "POST", url: "/auth/accept-invite", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "scoped", code: mint.json().code }),
    });
    const newToken = join.json().token as string;

    const repoList = await app.inject({ method: "GET", url: "/repos", headers: as(newToken) });
    expect((repoList.json().data as unknown[]).length).toBe(1);
  });
});

describe("the invite's time bound is the server's, not the caller's", () => {
  // "Single-use AND time-bounded" is the whole reason an invite beats a token
  // here. Caller-chosen TTL makes half of that a preference: ttlSeconds
  // 31_536_000_000 was measured returning 201 with expiresAt in the year 3026,
  // on a code that invite_agent prints into a chat transcript.
  const mint = (ttlSeconds?: number) => app.inject({
    method: "POST", url: `/repos/${provisioned}/invites`, headers: as(ownerToken),
    body: JSON.stringify({ suggestedName: "ttl", ...(ttlSeconds ? { ttlSeconds } : {}) }),
  });
  const daysOut = (res: { json(): { data: { expiresAt: string } } }) =>
    (new Date(res.json().data.expiresAt).getTime() - Date.now()) / 86_400_000;

  it("clamps an absurd TTL to the ceiling rather than honouring it", async () => {
    const res = await mint(31_536_000_000);
    expect(res.statusCode).toBe(201);
    expect(daysOut(res)).toBeLessThanOrEqual(7.1);
  });

  it("does not 500 on a TTL that overflows Date, which it used to", async () => {
    const res = await mint(315_360_000_000);
    expect(res.statusCode).toBe(201);
    expect(daysOut(res)).toBeLessThanOrEqual(7.1);
  });

  it("still honours a shorter TTL, because the clamp is a ceiling not an override", async () => {
    const res = await mint(3600);
    expect(daysOut(res)).toBeLessThan(0.2);
  });

  it("defaults to 7 days when none is given", async () => {
    const res = await mint();
    expect(daysOut(res)).toBeGreaterThan(6.9);
    expect(daysOut(res)).toBeLessThanOrEqual(7.1);
  });
});

describe("the boundaries that keep this from being a blank cheque", () => {
  it("cannot invite into another user's repo", async () => {
    const res = await app.inject({
      method: "POST", url: `/repos/${otherOwnerRepo}/invites`, headers: as(ownerToken),
      body: JSON.stringify({ suggestedName: "nope" }),
    });
    expect(res.statusCode).not.toBe(201);
  });

  it("an ordinary repo-scoped worker still cannot invite into a repo it is not in", async () => {
    const res = await app.inject({
      method: "POST", url: `/repos/${provisioned}/invites`, headers: as(workerToken),
      body: JSON.stringify({ suggestedName: "nope" }),
    });
    expect(res.statusCode).not.toBe(201);
  });

  it("a worker with owner scope still cannot mint an orchestrator invite", async () => {
    // Role and scope are different axes. Owner scope widens WHICH repos, never
    // WHAT you may grant, or the weakest agent in the fleet could mint the
    // credential that authors a shell verify predicate.
    const wOwner = "aio_prov_worker_owner_scoped";
    const w = await app.inject({
      method: "POST", url: "/agents", headers: ADMIN,
      body: JSON.stringify({ repoId: homeRepo, name: `prov-w-owner-${Date.now()}`, role: "worker" }),
    });
    await db.insert(tokens).values({
      id: `tok_prov_w_${Date.now()}`,
      agentId: w.json().data.id,
      ownerId: ownerA,
      tokenHash: hashToken(wOwner),
    });

    // A worker invite into the same repo with the same token FIRST, so a 403
    // below cannot be repo access wearing the role guard's status code.
    const control = await app.inject({
      method: "POST", url: `/repos/${provisioned}/invites`, headers: as(wOwner),
      body: JSON.stringify({ suggestedName: "control" }),
    });
    expect(control.statusCode).toBe(201);

    const res = await app.inject({
      method: "POST", url: `/repos/${provisioned}/invites`, headers: as(wOwner),
      body: JSON.stringify({ suggestedName: "escalate", role: "orchestrator" }),
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.message).toMatch(/orchestrator/i);
  });
});
