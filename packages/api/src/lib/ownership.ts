import type { FastifyRequest } from "fastify";
import { and, eq, type SQL } from "drizzle-orm";
import { projects, agents, type Db } from "@getrelai/db";

// Tenancy enforcement for project-scoped routes. Three auth modes resolve to
// three different access shapes:
//
//   1. Per-agent token  — `request.agent` is set; agent.projectId is the only
//      project they may touch. Cross-project access is forbidden regardless
//      of who owns the project.
//   2. Service-admin    — `request.ownerId` is set (from X-Owner-Id header).
//      Access is filtered to projects owned by that user.
//   3. Legacy API_SECRET — neither is set; full access. Self-hosters and seed
//      scripts rely on this; no filtering applied.
//
// Handlers that take a `:id` (or `projectId`) parameter call
// `assertProjectAccess`. List handlers call `scopedProjectFilter` to build a
// drizzle predicate they can AND into their existing where clause.

export async function assertProjectAccess(
  request: FastifyRequest,
  db: Db,
  projectId: string,
): Promise<{ ok: true } | { ok: false; status: 403 | 404 }> {
  if (request.agent) {
    if (request.agent.projectId !== projectId) return { ok: false, status: 403 };
    return { ok: true };
  }
  if (request.ownerId) {
    const [row] = await db
      .select({ id: projects.id })
      .from(projects)
      .where(and(eq(projects.id, projectId), eq(projects.ownerId, request.ownerId)))
      .limit(1);
    if (!row) return { ok: false, status: 404 };
    return { ok: true };
  }
  // Legacy API_SECRET path — full access.
  return { ok: true };
}

// For list endpoints. Returns a drizzle predicate to AND into the where
// clause, or null when no filtering is required (per-agent caller — they
// already filter by agent.projectId — or legacy API_SECRET).
export function scopedProjectFilter(request: FastifyRequest): SQL | null {
  if (request.ownerId) return eq(projects.ownerId, request.ownerId);
  return null;
}

// Convenience for routes that scope by agent (subscriptions, notification
// channels, tokens). Resolves the agent's project and reuses
// `assertProjectAccess`. Returns 404 to avoid leaking agent existence across
// tenants.
export async function assertAgentAccess(
  request: FastifyRequest,
  db: Db,
  agentId: string,
): Promise<{ ok: true; agent: typeof agents.$inferSelect } | { ok: false; status: 404 }> {
  const [agent] = await db.select().from(agents).where(eq(agents.id, agentId));
  if (!agent) return { ok: false, status: 404 };
  const access = await assertProjectAccess(request, db, agent.projectId);
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
      .innerJoin(projects, eq(projects.id, agents.projectId))
      .where(eq(projects.ownerId, request.ownerId));
    return rows.map((r) => r.id);
  }
  return null;
}
