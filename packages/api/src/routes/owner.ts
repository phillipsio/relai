import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { and, desc, eq, getTableColumns, inArray, isNull, or } from "drizzle-orm";
import { agents, invites, ownerGodAgents, tokens } from "@getrelai/db";
import type { Db } from "@getrelai/db";

const { codeHash: _codeHash, ...inviteFields } = getTableColumns(invites);

const notFound = { error: { code: "not_found", message: "No top-level agent" } };

// The dashboard acting for a signed-in owner. Never an agent: the god agent must
// not be able to see or undo its own revocation.
const dashboardOwner = (request: FastifyRequest) => (request.agent ? null : request.ownerId ?? null);

export const ownerRoutes: FastifyPluginAsync<{ db: Db }> = async (fastify, { db }) => {
  fastify.get("/owner/god-agent", async (request, reply) => {
    const owner = dashboardOwner(request);
    if (!owner) return reply.status(404).send(notFound);
    const [god] = await db.select().from(ownerGodAgents).where(eq(ownerGodAgents.ownerId, owner));
    if (!god) return reply.status(404).send(notFound);

    const [agent] = await db.select().from(agents).where(eq(agents.id, god.agentId));
    const minted = await db.select(inviteFields).from(invites)
      .where(eq(invites.createdBy, god.agentId))
      .orderBy(desc(invites.createdAt));
    return { data: { agent, since: god.createdAt, invites: minted } };
  });

  fastify.post("/owner/god-agent/revoke", async (request, reply) => {
    const owner = dashboardOwner(request);
    if (!owner) return reply.status(404).send(notFound);

    const result = await db.transaction(async (tx) => {
      const [god] = await tx.delete(ownerGodAgents).where(eq(ownerGodAgents.ownerId, owner)).returning();
      if (!god) return null;
      const now = new Date();

      const minted = await tx.select({ id: invites.id, acceptedAgentId: invites.acceptedAgentId })
        .from(invites).where(eq(invites.createdBy, god.agentId));
      const pending = await tx.update(invites).set({ revokedAt: now })
        .where(and(eq(invites.createdBy, god.agentId), isNull(invites.acceptedAt), isNull(invites.revokedAt)))
        .returning({ id: invites.id });

      const reached = [god.agentId, ...minted.flatMap((i) => (i.acceptedAgentId ? [i.acceptedAgentId] : []))];
      const revoked = await tx.update(tokens).set({ revokedAt: now })
        .where(and(isNull(tokens.revokedAt), or(inArray(tokens.agentId, reached), eq(tokens.ownerId, owner))))
        .returning({ id: tokens.id });

      return { agentId: god.agentId, invitesRevoked: pending.length, tokensRevoked: revoked.length };
    });

    if (!result) return reply.status(404).send(notFound);
    return { data: result };
  });
};
