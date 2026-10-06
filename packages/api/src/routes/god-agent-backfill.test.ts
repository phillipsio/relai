import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { buildServer } from "../server.js";
import { createDb, users, tokens, ownerGodAgents } from "@getrelai/db";
import { eq, inArray, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { generateToken, hashToken } from "../lib/tokens.js";

const DB_URL = process.env.DATABASE_URL ?? "postgresql://relai:relai@localhost:5433/relai";
const SECRET = "test-secret-god-backfill";
process.env.DATABASE_URL = DB_URL;
process.env.API_SECRET = SECRET;
const ADMIN = { Authorization: `Bearer ${SECRET}`, "Content-Type": "application/json" };

const DRIZZLE = join(__dirname, "../../../../shared/db/drizzle");
const migration = readFileSync(join(DRIZZLE, readdirSync(DRIZZLE).find((f) => f.startsWith("0011_"))!), "utf8");
const backfill = migration.split("--> statement-breakpoint").map((s) => s.trim()).find((s) => s.startsWith("INSERT INTO \"owner_god_agents\""))!;

const db = createDb(DB_URL);
let app: FastifyInstance;
const uniq = () => `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
const owners = { x: `usr_bf_x_${uniq()}`, y: `usr_bf_y_${uniq()}` };
let repoId: string;

const mkAgent = async () => (await app.inject({
  method: "POST", url: "/agents", headers: ADMIN, body: JSON.stringify({ repoId, name: `bf-${uniq()}`, role: "worker" }),
})).json().data.id as string;

const plant = (agentId: string, ownerId: string | null, createdAt: Date, revokedAt: Date | null = null) =>
  db.insert(tokens).values({ id: `tok_${uniq()}`, agentId, ownerId, tokenHash: hashToken(generateToken()), createdAt, revokedAt });

beforeAll(async () => {
  app = buildServer({ logger: false, scheduler: false });
  await app.ready();
  await db.insert(users).values(Object.values(owners).map((id) => ({ id, email: `${id}@test.invalid` })));
  repoId = (await app.inject({ method: "POST", url: "/repos", headers: ADMIN, body: JSON.stringify({ name: `__test__ bf ${uniq()}` }) })).json().data.id;
});

afterAll(async () => {
  await app.inject({ method: "DELETE", url: `/repos/${repoId}`, headers: ADMIN });
  await db.delete(users).where(inArray(users.id, Object.values(owners)));
  await app?.close();
});

describe("migration 0011's backfill", () => {
  it("is the statement under test", () => {
    expect(backfill).toMatch(/DISTINCT ON \("owner_id"\)/);
  });

  it("gives each owner's slot to its oldest live owner-scoped agent, skips revoked and unowned tokens, and is safe to rerun", async () => {
    const older = await mkAgent();
    const newer = await mkAgent();
    const revokedOnly = await mkAgent();
    const unowned = await mkAgent();
    await plant(newer, owners.x, new Date("2026-02-01"));
    await plant(older, owners.x, new Date("2026-01-01"));
    await plant(revokedOnly, owners.y, new Date("2026-01-01"), new Date("2026-01-02"));
    await plant(unowned, null, new Date("2026-01-01"));

    await db.execute(sql.raw(backfill));
    await db.execute(sql.raw(backfill));

    const rows = await db.select().from(ownerGodAgents).where(inArray(ownerGodAgents.ownerId, Object.values(owners)));
    expect(rows.map((r) => [r.ownerId, r.agentId])).toEqual([[owners.x, older]]);
    await db.delete(ownerGodAgents).where(eq(ownerGodAgents.ownerId, owners.x));
  });
});
