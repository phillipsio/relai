import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { buildServer } from "../server.js";
import type { FastifyInstance } from "fastify";
import { createDb, deviceAuthorizations, invites } from "@getrelai/db";
import { eq } from "drizzle-orm";
import { hashSecret } from "../lib/tokens.js";

const DB_URL = process.env.DATABASE_URL ?? "postgresql://relai:relai@localhost:5433/relai";
const SECRET = "test-secret-device-auth";

process.env.DATABASE_URL = DB_URL;
process.env.API_SECRET   = SECRET;

const ADMIN = { Authorization: `Bearer ${SECRET}`, "Content-Type": "application/json" };
const JSON_ONLY = { "Content-Type": "application/json" };

const db = createDb(DB_URL);

let app: FastifyInstance;
let repoId: string;

async function start(proposed: Record<string, unknown> = {}) {
  const res = await app.inject({
    method: "POST", url: "/auth/device/start",
    headers: JSON_ONLY,
    body: JSON.stringify({ proposed }),
  });
  expect(res.statusCode).toBe(201);
  return res.json() as {
    data: { userCode: string; verificationUri: string; expiresIn: number; interval: number };
    deviceCode: string;
  };
}

function poll(deviceCode: string) {
  return app.inject({
    method: "POST", url: "/auth/device/token",
    headers: { Authorization: `Bearer ${deviceCode}`, ...JSON_ONLY },
    body: "{}",
  });
}

function approve(userCode: string, agents: unknown[]) {
  return app.inject({
    method: "POST", url: "/auth/device/approve",
    headers: ADMIN,
    body: JSON.stringify({ userCode, repoId, agents }),
  });
}

/** Clears the poll rate-limit so a test can poll again without tripping slow_down. */
function unthrottle(id: string) {
  return db.update(deviceAuthorizations).set({ lastPolledAt: null }).where(eq(deviceAuthorizations.id, id));
}

beforeAll(async () => {
  app = buildServer({ logger: false, scheduler: false });
  await app.ready();

  const repo = await app.inject({
    method: "POST", url: "/repos",
    headers: ADMIN,
    body: JSON.stringify({ name: "__test__ device auth" }),
  });
  expect(repo.statusCode).toBe(201);
  repoId = repo.json().data.id;
});

afterAll(async () => { await app.close(); });

describe("POST /auth/device/start", () => {
  it("is public: no credential of any kind is required to begin", async () => {
    const res = await app.inject({
      method: "POST", url: "/auth/device/start",
      headers: JSON_ONLY, body: JSON.stringify({ proposed: {} }),
    });
    expect(res.statusCode).toBe(201);
  });

  it("returns the four things a client needs to drive the wait", async () => {
    const { data, deviceCode } = await start();
    expect(deviceCode).toMatch(/^dev_/);
    expect(data.userCode).toBeTruthy();
    expect(data.verificationUri).toContain("/device");
    expect(data.expiresIn).toBeGreaterThan(0);
    expect(data.interval).toBeGreaterThan(0);
  });

  it("draws the user code from an alphabet a human cannot misread", async () => {
    // Twenty draws, because a single code can miss a bad character by luck.
    for (let i = 0; i < 20; i++) {
      const { data } = await start();
      expect(data.userCode).toMatch(/^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
    }
  });

  it("stores the device code hashed, never in the clear", async () => {
    const { deviceCode } = await start();
    const [row] = await db.select().from(deviceAuthorizations)
      .where(eq(deviceAuthorizations.deviceCodeHash, hashSecret(deviceCode)));
    expect(row).toBeTruthy();
    expect(JSON.stringify(row)).not.toContain(deviceCode);
  });

  it("keeps what the client detected, as advisory data", async () => {
    const { deviceCode } = await start({ repoName: "front-end-app-v2", runtimes: ["claude", "cursor"] });
    const [row] = await db.select().from(deviceAuthorizations)
      .where(eq(deviceAuthorizations.deviceCodeHash, hashSecret(deviceCode)));
    expect(row.proposed).toEqual({ repoName: "front-end-app-v2", runtimes: ["claude", "cursor"] });
    expect(row.granted).toBeNull();
    expect(row.repoId).toBeNull();
  });
});

describe("POST /auth/device/token", () => {
  it("says authorization_pending while nobody has approved", async () => {
    const { deviceCode } = await start();
    const res = await poll(deviceCode);
    expect(res.statusCode).toBe(428);
    expect(res.json().error.code).toBe("authorization_pending");
  });

  it("says slow_down when polled again inside the interval", async () => {
    const { deviceCode } = await start();
    expect((await poll(deviceCode)).statusCode).toBe(428);
    const second = await poll(deviceCode);
    expect(second.statusCode).toBe(429);
    expect(second.json().error.code).toBe("slow_down");
  });

  it("refuses an unknown device code without saying whether one exists", async () => {
    const res = await poll("dev_not_a_real_code");
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("invalid_device_code");
  });

  it("distinguishes expired from pending, so a client stops instead of spinning", async () => {
    const { deviceCode } = await start();
    await db.update(deviceAuthorizations)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(deviceAuthorizations.deviceCodeHash, hashSecret(deviceCode)));
    const res = await poll(deviceCode);
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("expired_token");
  });

  it("reports a denial as its own outcome, not as a failure to approve", async () => {
    const { deviceCode, data } = await start();
    const denied = await app.inject({
      method: "POST", url: "/auth/device/deny",
      headers: ADMIN, body: JSON.stringify({ userCode: data.userCode }),
    });
    expect(denied.statusCode).toBe(204);
    const res = await poll(deviceCode);
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("access_denied");
  });

  it("returns one redeemable invite code per approved agent", async () => {
    const { deviceCode, data } = await start();
    const ok = await approve(data.userCode, [
      { name: "claude-code", workerType: "claude", role: "orchestrator" },
      { name: "cursor",      workerType: "cursor", role: "worker", specialization: "reviewer" },
    ]);
    expect(ok.statusCode).toBe(200);

    const [row] = await db.select().from(deviceAuthorizations)
      .where(eq(deviceAuthorizations.deviceCodeHash, hashSecret(deviceCode)));
    await unthrottle(row.id);

    const res = await poll(deviceCode);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.data.repoId).toBe(repoId);
    expect(body.invites).toHaveLength(2);

    const cursor = body.invites.find((i: { name: string }) => i.name === "cursor");
    expect(cursor.workerType).toBe("cursor");
    expect(cursor.specialization).toBe("reviewer");
    expect(cursor.code).toMatch(/^inv_/);

    const accepted = await app.inject({
      method: "POST", url: "/auth/accept-invite",
      headers: JSON_ONLY,
      body: JSON.stringify({ code: cursor.code, name: "cursor", role: "worker", workerType: "cursor" }),
    });
    expect(accepted.statusCode).toBe(201);
    expect(accepted.json().token).toMatch(/^aio_/);
  });

  it("hands the codes over exactly once, and mints no second set on a replay", async () => {
    const { deviceCode, data } = await start();
    expect((await approve(data.userCode, [{ name: "solo", workerType: "claude", role: "worker" }])).statusCode).toBe(200);

    const [row] = await db.select().from(deviceAuthorizations)
      .where(eq(deviceAuthorizations.deviceCodeHash, hashSecret(deviceCode)));

    await unthrottle(row.id);
    expect((await poll(deviceCode)).statusCode).toBe(200);

    await unthrottle(row.id);
    const replay = await poll(deviceCode);
    expect(replay.statusCode).toBe(400);
    expect(replay.json().error.code).toBe("expired_token");

    const minted = await db.select().from(invites).where(eq(invites.deviceAuthorizationId, row.id));
    expect(minted).toHaveLength(1);
  });

  it("mints one set of invites even when two polls arrive together", async () => {
    // A sequential replay is refused by the same guard, so only two polls
    // landing together can show it holds under an actual race.
    const { deviceCode, data } = await start();
    expect((await approve(data.userCode, [
      { name: "racer-a", workerType: "claude", role: "worker" },
      { name: "racer-b", workerType: "cursor", role: "worker" },
    ])).statusCode).toBe(200);

    const [row] = await db.select().from(deviceAuthorizations)
      .where(eq(deviceAuthorizations.deviceCodeHash, hashSecret(deviceCode)));
    await unthrottle(row.id);

    const [a, b] = await Promise.all([poll(deviceCode), poll(deviceCode)]);
    const codes = [a.statusCode, b.statusCode];
    expect(codes.filter((c) => c === 200)).toHaveLength(1);

    const minted = await db.select().from(invites).where(eq(invites.deviceAuthorizationId, row.id));
    expect(minted).toHaveLength(2);
  });
});

describe("POST /auth/device/approve", () => {
  it("refuses a user code that does not exist", async () => {
    const res = await approve("ZZZZ-9999", [{ name: "x", workerType: "claude", role: "worker" }]);
    expect(res.statusCode).toBe(404);
  });

  it("refuses to approve something already expired", async () => {
    const { deviceCode, data } = await start();
    await db.update(deviceAuthorizations)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(deviceAuthorizations.deviceCodeHash, hashSecret(deviceCode)));
    const res = await approve(data.userCode, [{ name: "x", workerType: "claude", role: "worker" }]);
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("expired_token");
  });

  it("refuses a second decision on an authorization already decided", async () => {
    const { data } = await start();
    expect((await approve(data.userCode, [{ name: "a", workerType: "claude", role: "worker" }])).statusCode).toBe(200);
    const again = await approve(data.userCode, [{ name: "b", workerType: "cursor", role: "worker" }]);
    expect(again.statusCode).toBe(409);
  });

  it("requires at least one agent, so an empty approval cannot look like success", async () => {
    const { data } = await start();
    const res = await approve(data.userCode, []);
    expect(res.statusCode).toBe(400);
  });

  it("is not public: a caller without the service credential cannot approve", async () => {
    const { data } = await start();
    const res = await app.inject({
      method: "POST", url: "/auth/device/approve",
      headers: JSON_ONLY,
      body: JSON.stringify({ userCode: data.userCode, repoId, agents: [{ name: "x", workerType: "claude", role: "worker" }] }),
    });
    expect(res.statusCode).toBe(401);
  });
});
