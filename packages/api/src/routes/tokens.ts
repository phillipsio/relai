import type { FastifyPluginAsync } from "fastify";
import { eq } from "drizzle-orm";
import { tokens } from "@getrelai/db";
import { assertAgentAccess } from "../lib/ownership.js";
import type { Db } from "@getrelai/db";

export const tokenRoutes: FastifyPluginAsync<{ db: Db }> = async (fastify, { db }) => {
  fastify.delete<{ Params: { id: string } }>("/tokens/:id", async (request, reply) => {
    const [existing] = await db.select().from(tokens).where(eq(tokens.id, request.params.id));
    if (!existing) return reply.status(404).send({ error: { code: "not_found", message: "Token not found" } });
    const access = await assertAgentAccess(request, db, existing.agentId);
    if (!access.ok) return reply.status(access.status).send({ error: { code: "not_found", message: "Token not found" } });

    await db
      .update(tokens)
      .set({ revokedAt: new Date() })
      .where(eq(tokens.id, request.params.id));

    return reply.status(204).send();
  });
};
