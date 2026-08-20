import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { buildServer } from "../server.js";
import { createDb, users, repos } from "@getrelai/db";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";

const DB_URL = process.env.DATABASE_URL ?? "postgresql://relai:relai@localhost:5433/relai";
const SECRET = "test-secret-directory";

process.env.DATABASE_URL = DB_URL;
process.env.API_SECRET = SECRET;

const ADMIN = { Authorization: `Bearer ${SECRET}`, "Content-Type": "application/json" };
const asAgent = (t: string) => ({ Authorization: `Bearer ${t}`, "Content-Type": "application/json" });

let app: FastifyInstance;
const ownerA = "usr_dir_owner_a";
const ownerB = "usr_dir_owner_b";
let repoA1: string, repoA2: string, repoB: string, repoOrphan: string;
let tokenA1: string, tokenOrphan: string;
let orphanSelf: string;
let peerInA2: string, peerInB: string, peerInOrphanSibling: string;

const mkRepo = async (name: string, owner: string | null) => {
  const r = await app.inject({ method: "POST", url: "/repos", headers: ADMIN, body: JSON.stringify({ name }) });
  const id = r.json().data.id as string;
  const db = createDb(DB_URL);
  await db.update(repos).set({ ownerId: owner }).where(eq(repos.id, id));
  return id;
};
const mkAgent = async (repoId: string, name: string) => {
  const a = await app.inject({
    method: "POST", url: "/agents", headers: ADMIN, body: JSON.stringify({ repoId, name, role: "worker" }),
  });
  return { id: a.json().data.id as string, token: a.json().token as string };
};

beforeAll(async () => {
  app = buildServer({ logger: false, scheduler: false });
  await app.ready();
  const db = createDb(DB_URL);
  for (const u of [ownerA, ownerB]) {
    await db.insert(users).values({ id: u, email: `${u}@test.local` }).onConflictDoNothing();
  }

  repoA1 = await mkRepo("__test__ dir A1", ownerA);
  repoA2 = await mkRepo("__test__ dir A2", ownerA);
  repoB  = await mkRepo("__test__ dir B", ownerB);
  repoOrphan = await mkRepo("__test__ dir orphan", null);
  const orphanSibling = await mkRepo("__test__ dir orphan2", null);

  ({ token: tokenA1 } = await mkAgent(repoA1, "dir-a1"));
  ({ id: peerInA2 } = await mkAgent(repoA2, "dir-a2-peer"));
  ({ id: peerInB } = await mkAgent(repoB, "dir-b-peer"));
  ({ id: orphanSelf, token: tokenOrphan } = await mkAgent(repoOrphan, "dir-orphan"));
  ({ id: peerInOrphanSibling } = await mkAgent(orphanSibling, "dir-orphan2-peer"));
});

afterAll(async () => {
  const db = createDb(DB_URL);
  const all = await db.select({ id: repos.id, name: repos.name }).from(repos);
  for (const r of all.filter((x) => x.name.startsWith("__test__ dir"))) {
    await app.inject({ method: "DELETE", url: `/repos/${r.id}`, headers: ADMIN });
  }
  await app?.close();
});

const list = async (token: string) => {
  const res = await app.inject({ method: "GET", url: "/agents", headers: asAgent(token) });
  return (res.json().data as Array<{ id: string }>).map((a) => a.id);
};

describe("an agent can see its owner's fleet, and no further", () => {
  it("includes a peer in a sibling repo under the same owner", async () => {
    expect(await list(tokenA1)).toContain(peerInA2);
  });

  it("excludes another owner's agents", async () => {
    expect(await list(tokenA1)).not.toContain(peerInB);
  });

  // Without this, "same owner" matches every unowned repo on a self-hosted
  // instance and a directory becomes a disclosure.
  it("falls back to own-repo only when the owner is null", async () => {
    const seen = await list(tokenOrphan);

    // Must still see its own repo. Without the explicit fallback the sibling
    // query matches on owner_id = NULL, which is never true, so the agent gets
    // an empty directory rather than a scoped one.
    expect(seen).toContain(orphanSelf);
    expect(seen).not.toContain(peerInOrphanSibling);
    expect(seen).not.toContain(peerInA2);
  });

  it("still grants no read access to a sibling repo's work", async () => {
    const tasks = await app.inject({
      method: "GET", url: `/tasks?repoId=${repoA2}`, headers: asAgent(tokenA1),
    });
    // Scoped to the caller's own repo regardless of the requested one.
    expect(tasks.json().data).toEqual([]);
  });
});
