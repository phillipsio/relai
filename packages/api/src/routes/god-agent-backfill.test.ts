import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { buildServer } from "../server.js";
import { createDb, users, tokens, invites, ownerGodAgents } from "@getrelai/db";
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
const statements = migration.split("--> statement-breakpoint").map((s) => s.trim());
const backfill = statements.find((s) => s.startsWith("INSERT INTO \"owner_god_agents\""))!;
// The direct stamp (every live owner-scoped token) and the two lineage
// walks (invite descendants, then THEIR tokens) are each their own
// statement — a CTE doesn't survive across statement-breakpoints, so the
// token-lineage walk re-derives the same recursion the invite-lineage walk
// already did.
const backfillDirectTokenStamp = statements.find((s) => s.includes("SET \"chain_slot_id\" = g.\"id\""))!;
const backfillInviteLineage = statements.find((s) => s.includes("UPDATE \"invites\" i"))!;
const backfillTokenLineage = statements.find((s) => s.includes("UPDATE \"tokens\" t") && s.includes("l.slot_id"))!;

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
    // Also planted tokens, not just the slot row — a later test in this file
    // reuses the same owners.x, and a leftover owner-scoped token here can
    // tie with (or beat) that test's own on created_at and win the
    // DISTINCT ON, pointing its slot at the wrong agent.
    await db.delete(tokens).where(inArray(tokens.agentId, [older, newer, revokedOnly, unowned]));
  });

  it("stamps a descendant agent's own token too, not just the invite it was redeemed through — live or revoked", async () => {
    // Pre-migration state: a god-era agent with a live owner-scoped token,
    // who invited two workers before this rebuild existed. The workers' own
    // tokens carry no owner_id (ordinary tokens never do) and are the
    // specific rows the direct-stamp UPDATE can't see.
    const godAgent = await mkAgent();
    const descendant = await mkAgent();
    // A second descendant whose only token was already revoked before the
    // migration ran (e.g. a peer orchestrator revoked it, mid-rotation).
    // Skipping revoked rows here would leave it unstamped forever: its next
    // rotation carries the stamp from its newest token regardless of live
    // status (agents.ts), and a dead, never-stamped row there produces the
    // same unstamped, un-revocable credential the rotation fix exists to
    // prevent.
    const revokedDescendant = await mkAgent();
    await plant(godAgent, owners.x, new Date("2026-01-01"));
    const [invite] = await db.insert(invites).values({
      id: `invite_${uniq()}`, repoId, codeHash: `hash_${uniq()}`, createdBy: godAgent, acceptedAgentId: descendant,
      expiresAt: new Date("2027-01-01"), acceptedAt: new Date("2026-01-02"),
    }).returning();
    const [revokedInvite] = await db.insert(invites).values({
      id: `invite_${uniq()}`, repoId, codeHash: `hash_${uniq()}`, createdBy: godAgent, acceptedAgentId: revokedDescendant,
      expiresAt: new Date("2027-01-01"), acceptedAt: new Date("2026-01-02"),
    }).returning();
    const [descendantToken] = await db.insert(tokens).values({
      id: `tok_${uniq()}`, agentId: descendant, ownerId: null, tokenHash: hashToken(generateToken()), createdAt: new Date("2026-01-02"),
    }).returning();
    const [revokedToken] = await db.insert(tokens).values({
      id: `tok_${uniq()}`, agentId: revokedDescendant, ownerId: null, tokenHash: hashToken(generateToken()),
      createdAt: new Date("2026-01-02"), revokedAt: new Date("2026-01-03"),
    }).returning();

    await db.execute(sql.raw(backfill));
    const [slot] = await db.select().from(ownerGodAgents).where(eq(ownerGodAgents.ownerId, owners.x));
    await db.execute(sql.raw(backfillDirectTokenStamp));
    await db.execute(sql.raw(backfillInviteLineage));
    await db.execute(sql.raw(backfillTokenLineage));

    const [invRow] = await db.select({ chainSlotId: invites.chainSlotId }).from(invites).where(eq(invites.id, invite.id));
    expect(invRow.chainSlotId).toBe(slot.id);
    const [tokRow] = await db.select({ chainSlotId: tokens.chainSlotId }).from(tokens).where(eq(tokens.id, descendantToken.id));
    expect(tokRow.chainSlotId).toBe(slot.id);
    const [revokedTokRow] = await db.select({ chainSlotId: tokens.chainSlotId }).from(tokens).where(eq(tokens.id, revokedToken.id));
    expect(revokedTokRow.chainSlotId).toBe(slot.id);

    await db.delete(invites).where(inArray(invites.id, [invite.id, revokedInvite.id]));
    await db.delete(ownerGodAgents).where(eq(ownerGodAgents.ownerId, owners.x));
  });
});
