import type { FastifyPluginAsync } from "fastify";
import { eq } from "drizzle-orm";
import { tokens } from "@relai/db";
import type { Db } from "@relai/db";

export const tokenRoutes: FastifyPluginAsync<{ db: Db }> = async (fastify, { db }) => {
  fastify.delete<{ Params: { id: string } }>("/tokens/:id", async (request, reply) => {
    const [row] = await db
      .update(tokens)
      .set({ revokedAt: new Date() })
      .where(eq(tokens.id, request.params.id))
      .returning();

    if (!row) return reply.status(404).send({ error: { code: "not_found", message: "Token not found" } });
    return reply.status(204).send();
  });
};
