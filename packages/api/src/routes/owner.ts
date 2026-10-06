import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { and, desc, eq, getTableColumns, inArray, isNull, or } from "drizzle-orm";
import { agents, invites, ownerGodAgents, tokens } from "@getrelai/db";
import type { Db } from "@getrelai/db";

const { codeHash: _codeHash, ...inviteFields } = getTableColumns(invites);

const notFound = { error: { code: "not_found", message: "No top-level agent" } };

// The dashboard acting for a signed-in owner, never an agent: the top-level agent
// must not be able to see or undo its own revocation.
const dashboardOwner = (request: FastifyRequest) => (request.agent ? null : request.ownerId ?? null);

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

async function scopeHolders(db: Db | Tx, owner: string): Promise<string[]> {
  const [slot] = await db.select({ agentId: ownerGodAgents.agentId }).from(ownerGodAgents).where(eq(ownerGodAgents.ownerId, owner));
  const holders = await db.selectDistinct({ agentId: tokens.agentId }).from(tokens)
    .where(and(eq(tokens.ownerId, owner), isNull(tokens.revokedAt)));
  return [...new Set([...(slot ? [slot.agentId] : []), ...holders.map((h) => h.agentId)])];
}

export const ownerRoutes: FastifyPluginAsync<{ db: Db }> = async (fastify, { db }) => {
  fastify.get("/owner/god-agent", async (request, reply) => {
    const owner = dashboardOwner(request);
    if (!owner) return reply.status(404).send(notFound);
    const ids = await scopeHolders(db, owner);
    if (ids.length === 0) return reply.status(404).send(notFound);

    const holders = await db.select().from(agents).where(inArray(agents.id, ids));
    const minted = await db.select(inviteFields).from(invites)
      .where(inArray(invites.createdBy, ids))
      .orderBy(desc(invites.createdAt));
    return { data: { agents: holders, invites: minted } };
  });

  fastify.post("/owner/god-agent/revoke", async (request, reply) => {
    const owner = dashboardOwner(request);
    if (!owner) return reply.status(404).send(notFound);

    const result = await db.transaction(async (tx) => {
      const seeds = await scopeHolders(tx, owner);
      if (seeds.length === 0) return null;

      // Locking each generation's invites first makes an in-flight redeem finish
      // (and show its acceptedAgentId) or wait behind this revoke.
      const reached = new Set(seeds);
      for (let frontier = seeds; frontier.length > 0;) {
        const redeemed = await tx.select({ agentId: invites.acceptedAgentId }).from(invites)
          .where(inArray(invites.createdBy, frontier)).orderBy(invites.id).for("update");
        frontier = redeemed.flatMap((r) => (r.agentId && !reached.has(r.agentId) ? [r.agentId] : []));
        for (const id of frontier) reached.add(id);
      }
      const ids = [...reached];
      await tx.select({ id: agents.id }).from(agents).where(inArray(agents.id, ids)).orderBy(agents.id).for("update");

      const now = new Date();
      const pending = await tx.update(invites).set({ revokedAt: now })
        .where(and(inArray(invites.createdBy, ids), isNull(invites.acceptedAt), isNull(invites.revokedAt)))
        .returning({ id: invites.id });
      const revoked = await tx.update(tokens).set({ revokedAt: now })
        .where(and(isNull(tokens.revokedAt), or(inArray(tokens.agentId, ids), eq(tokens.ownerId, owner))))
        .returning({ id: tokens.id });
      await tx.delete(ownerGodAgents).where(eq(ownerGodAgents.ownerId, owner));

      return { agentsReached: ids.length, invitesRevoked: pending.length, tokensRevoked: revoked.length };
    });

    if (!result) return reply.status(404).send(notFound);
    return { data: result };
  });
};
