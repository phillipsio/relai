import type { FastifyPluginAsync } from "fastify";
import fp from "fastify-plugin";
import { eq, and, isNull } from "drizzle-orm";
import { tokens, agents, type Db } from "@relai/db";
import { hashToken, looksLikeAgentToken } from "../lib/tokens.js";

type Agent = typeof agents.$inferSelect;

declare module "fastify" {
  interface FastifyRequest {
    agent?: Agent;
  }
}

const authPlugin: FastifyPluginAsync<{ db: Db }> = async (fastify, { db }) => {
  fastify.decorateRequest("agent", null);

  // Endpoints that authenticate via their request body (e.g. invite codes)
  // and therefore must be reachable without a bearer token.
  const PUBLIC_PATHS = new Set<string>(["/auth/accept-invite"]);

  fastify.addHook("onRequest", async (request, reply) => {
    if (PUBLIC_PATHS.has(request.url.split("?")[0])) return;

    const auth = request.headers.authorization;
    if (!auth || !auth.startsWith("Bearer ")) {
      return reply.status(401).send({ error: { code: "unauthorized", message: "Missing bearer token" } });
    }
    const token = auth.slice(7);

    if (looksLikeAgentToken(token)) {
      const tokenHash = hashToken(token);
      const [row] = await db
        .select({ token: tokens, agent: agents })
        .from(tokens)
        .innerJoin(agents, eq(agents.id, tokens.agentId))
        .where(and(eq(tokens.tokenHash, tokenHash), isNull(tokens.revokedAt)))
        .limit(1);

      if (!row) {
        return reply.status(401).send({ error: { code: "unauthorized", message: "Invalid or revoked token" } });
      }
      request.agent = row.agent;
      // Fire-and-forget last-used update; don't block the request.
      void db.update(tokens).set({ lastUsedAt: new Date() }).where(eq(tokens.id, row.token.id));
      return;
    }

    if (process.env.API_SECRET && token === process.env.API_SECRET) {
      // Legacy shared-secret fallback. Deprecated — issue per-agent tokens instead.
      return;
    }

    return reply.status(401).send({ error: { code: "unauthorized", message: "Invalid token" } });
  });
};

export default fp(authPlugin);
