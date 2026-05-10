import type { FastifyRequest } from "fastify";
import { and, eq, type SQL } from "drizzle-orm";
import { projects, type Db } from "@getrelai/db";

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
