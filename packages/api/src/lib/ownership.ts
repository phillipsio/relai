import type { FastifyRequest } from "fastify";
import { and, eq, type SQL } from "drizzle-orm";
import { repos, agents, threads, type Db } from "@getrelai/db";
import { isDmParticipant } from "./dm.js";

// Tenancy enforcement for project-scoped routes. Three auth modes resolve to
// three different access shapes:
//
//   1. Per-agent token  — `request.agent` is set. Its own repo, plus, when the
//      token row carries `tokens.ownerId` (the super agent), every repo that
//      owner owns. Without owner scope, cross-project access is forbidden
//      regardless of who owns the project.
//   2. Owner            — `request.ownerId` is set, from an X-Owner-Id header
//      on the dashboard path OR from the token row on the super agent's path.
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
    if (request.agent.repoId === repoId) return { ok: true };
    // An owner-scoped token (tokens.ownerId) widens an agent beyond its home
    // repo to the ones its owner owns. A UNION rather than a replacement: the
    // home repo above still resolves even when that repo has no owner at all,
    // which is the self-hosted default and would otherwise lock the agent out
    // of the one project it actually lives in.
    if (request.ownerId) {
      const [owned] = await db
        .select({ id: repos.id })
        .from(repos)
        .where(and(eq(repos.id, repoId), eq(repos.ownerId, request.ownerId)))
        .limit(1);
      if (owned) return { ok: true };
    }
    return { ok: false, status: 403 };
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

// Callers must already be repo-scoped (assertAgentAccess / assertRepoAccess);
// the orchestrator arm does not itself compare repos, and for an owner that
// scoping is the ONLY confinement, since the answer below is unconditional.
// `ownership-callsites.test.ts` re-derives that invariant across the route
// files rather than trusting this sentence.
//
// An owner gets the same unrestricted answer as the legacy shared secret, and
// that is a decision rather than an oversight: assertRepoAccess has already
// confined it to `repos.ownerId = request.ownerId`, and inside that boundary it
// can delete the repo outright. Deliberately NOT a separate arm, because that
// branch would be indistinguishable from the one below it; `ownership.test.ts`
// records the decision where it can fail instead.
//
// THE SUPER AGENT IS A PROXY FOR THE USER and therefore does act across the
// repos its owner owns, including on other agents there. That is intended, not
// a gap. What bounds it is not this function: owner scope is grantable only to
// an orchestrator (device-auth refuses a worker), and destructive acts are
// meant to become recoverable rather than forbidden (task_j03oUMlGHG-bkYQQO-hby).
// An earlier version of this comment claimed the agent-first ordering stopped
// the token being "a master key over every agent in the owner's repos". That
// was false for an orchestrator, and the ordering buys something narrower: an
// agent identity is judged by its role before any owner scope is consulted.
export function callerMayActOnAgent(request: FastifyRequest, targetAgentId: string): boolean {
  if (!request.agent) return true;
  return request.agent.id === targetAgentId || request.agent.role === "orchestrator";
}

// Callers must already be repo-scoped (assertRepoAccess). DELETE removes every
// agent in the repo, so membership alone is not enough. Owner and legacy-secret
// callers share the unrestricted answer for the same reason as above, and the
// same ordering constraint applies.
export function callerMayAdministerRepo(request: FastifyRequest): boolean {
  if (!request.agent) return true;
  return request.agent.role === "orchestrator";
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

// Repos an agent may see peers in, shared by GET /agents and direct messaging.
// Null owner must fall back: `= NULL` matches nothing, `IS NULL` matches every unowned repo.
export async function peerRepoIds(db: Db, agent: typeof agents.$inferSelect): Promise<string[]> {
  const [own] = await db.select({ ownerId: repos.ownerId }).from(repos).where(eq(repos.id, agent.repoId));
  if (!own?.ownerId) return [agent.repoId];
  const rows = await db.select({ id: repos.id }).from(repos).where(eq(repos.ownerId, own.ownerId));
  return rows.map((r) => r.id);
}

// Can a repo-scoped surface treat this thread as its own? Separate question from
// loadThreadScoped, which asks whether a CALLER may read one: this takes no request
// and must hold for the admin path too, so that check would wave through exactly the
// case this exists to refuse. What it shares is the rule that `type === "dm"` means
// repo membership is not sufficient, and that rule lives in this file because two
// copies of it drifted once already.
export function threadOwnableByRepo(
  thread: { repoId: string; type: string | null },
  repoId: string,
): boolean {
  return thread.repoId === repoId && thread.type !== "dm";
}

// The one place thread access is decided. Two copies drifted once already.
export async function loadThreadScoped(
  request: FastifyRequest,
  db: Db,
  threadId: string,
): Promise<{ ok: true; thread: typeof threads.$inferSelect } | { ok: false; status: 404 }> {
  const [thread] = await db.select().from(threads).where(eq(threads.id, threadId));
  if (!thread) return { ok: false, status: 404 };
  // A DM lives in the sender's repo but is not repo-readable: participants only.
  // Owner/admin still reach it via the repo check, as they do for reads.
  if (thread.type === "dm" && request.agent) {
    if (!isDmParticipant(thread, request.agent.id)) return { ok: false, status: 404 };
    return { ok: true, thread };
  }
  const access = await assertRepoAccess(request, db, thread.repoId);
  if (!access.ok) return { ok: false, status: 404 };
  return { ok: true, thread };
}
