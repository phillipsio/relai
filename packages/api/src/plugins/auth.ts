import type { FastifyPluginAsync } from "fastify";
import fp from "fastify-plugin";
import { eq, and, isNull } from "drizzle-orm";
import { tokens, agents, type Db } from "@getrelai/db";
import { hashToken, looksLikeAgentToken } from "../lib/tokens.js";

type Agent = typeof agents.$inferSelect;

declare module "fastify" {
  interface FastifyRequest {
    agent?: Agent;
    // Set when the request authenticates with SERVICE_ADMIN_TOKEN and carries
    // an X-Owner-Id header. The closed cloud dashboard uses this path to act
    // on behalf of a logged-in user; ownership-aware route handlers filter by
    // this value. Null on per-agent tokens and the legacy API_SECRET path.
    ownerId?: string;
  }
}

const authPlugin: FastifyPluginAsync<{ db: Db }> = async (fastify, { db }) => {
  fastify.decorateRequest("agent", null);
  fastify.decorateRequest("ownerId", null);

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
      // Fire-and-forget activity stamps; don't block the request. Bumping
      // agents.lastSeenAt here (not just on /heartbeat) keeps the routing
      // scheduler's "online" filter accurate for any agent driving the API
      // — CLI, MCP, or HTTP — not only ones that send explicit heartbeats.
      const now = new Date();
      void db.update(tokens).set({ lastUsedAt: now }).where(eq(tokens.id, row.token.id));
      void db.update(agents).set({ lastSeenAt: now }).where(eq(agents.id, row.agent.id));
      return;
    }

    if (process.env.SERVICE_ADMIN_TOKEN && token === process.env.SERVICE_ADMIN_TOKEN) {
      // Multi-tenant service-admin path. The closed cloud dashboard uses this
      // to call the API on behalf of a logged-in user; the X-Owner-Id header
      // tells route handlers which tenant's rows to scope to.
      const ownerHeader = request.headers["x-owner-id"];
      const ownerId = Array.isArray(ownerHeader) ? ownerHeader[0] : ownerHeader;
      if (typeof ownerId !== "string" || !ownerId.startsWith("usr_")) {
        return reply.status(400).send({
          error: { code: "owner_required", message: "X-Owner-Id header required for service admin auth" },
        });
      }
      request.ownerId = ownerId;
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
