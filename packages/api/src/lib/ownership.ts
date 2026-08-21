import type { FastifyRequest } from "fastify";
import { and, eq, type SQL } from "drizzle-orm";
import { repos, agents, type Db } from "@getrelai/db";

// Tenancy enforcement for project-scoped routes. Three auth modes resolve to
// three different access shapes:
//
//   1. Per-agent token  — `request.agent` is set; agent.repoId is the only
//      project they may touch. Cross-project access is forbidden regardless
//      of who owns the project.
//   2. Service-admin    — `request.ownerId` is set (from X-Owner-Id header).
//      Access is filtered to repos owned by that user.
//   3. Legacy API_SECRET — neither is set; full access. Self-hosters and seed
//      scripts rely on this; no filtering applied.
//
// Handlers that take a `:id` (or `repoId`) parameter call
// `assertRepoAccess`. List handlers call `scopedRepoFilter` to build a
// drizzle predicate they can AND into their existing where clause.

export async function assertRepoAccess(
  request: FastifyRequest,
  db: Db,
  repoId: string,
): Promise<{ ok: true } | { ok: false; status: 403 | 404 }> {
  if (request.agent) {
    if (request.agent.repoId !== repoId) return { ok: false, status: 403 };
    return { ok: true };
  }
  if (request.ownerId) {
    const [row] = await db
      .select({ id: repos.id })
      .from(repos)
      .where(and(eq(repos.id, repoId), eq(repos.ownerId, request.ownerId)))
      .limit(1);
    if (!row) return { ok: false, status: 404 };
    return { ok: true };
  }
  // Legacy API_SECRET path — full access.
  return { ok: true };
}

// For list endpoints. Returns a drizzle predicate to AND into the where
// clause, or null when no filtering is required (per-agent caller — they
// already filter by agent.repoId — or legacy API_SECRET).
export function scopedRepoFilter(request: FastifyRequest): SQL | null {
  if (request.ownerId) return eq(repos.ownerId, request.ownerId);
  return null;
}

// Convenience for routes that scope by agent (subscriptions, notification
// channels, tokens). Resolves the agent's project and reuses
// `assertRepoAccess`. Returns 404 to avoid leaking agent existence across
// tenants.
export async function assertAgentAccess(
  request: FastifyRequest,
  db: Db,
  agentId: string,
): Promise<{ ok: true; agent: typeof agents.$inferSelect } | { ok: false; status: 404 }> {
  const [agent] = await db.select().from(agents).where(eq(agents.id, agentId));
  if (!agent) return { ok: false, status: 404 };
  const access = await assertRepoAccess(request, db, agent.repoId);
  if (!access.ok) return { ok: false, status: 404 };
  return { ok: true, agent };
}

// For routes that filter rows by agentId. Returns the list of agent IDs the
// caller can see, or null when no filtering applies (API_SECRET path = full
// visibility). Per-agent callers see only their own agent.
export async function scopedAgentIds(request: FastifyRequest, db: Db): Promise<string[] | null> {
  if (request.agent) return [request.agent.id];
  if (request.ownerId) {
    const rows = await db
      .select({ id: agents.id })
      .from(agents)
      .innerJoin(repos, eq(repos.id, agents.repoId))
      .where(eq(repos.ownerId, request.ownerId));
    return rows.map((r) => r.id);
  }
  return null;
}

// Repos an agent may see peers in: every repo sharing its owner. Falls back to
// its own repo when the owner is null (the self-hosted default), because
// `owner_id = NULL` matches nothing and matching `IS NULL` would instead pool
// every unowned repo on the instance. Visibility and reachability are the same
// question, so `GET /agents` and direct messaging both resolve it here — a peer
// you cannot see must not be a peer you can message.
export async function peerRepoIds(db: Db, agent: typeof agents.$inferSelect): Promise<string[]> {
  const [own] = await db.select({ ownerId: repos.ownerId }).from(repos).where(eq(repos.id, agent.repoId));
  if (!own?.ownerId) return [agent.repoId];
  const rows = await db.select({ id: repos.id }).from(repos).where(eq(repos.ownerId, own.ownerId));
  return rows.map((r) => r.id);
}
