import type { FastifyPluginAsync } from "fastify";
import fp from "fastify-plugin";
import { eq, and, isNull } from "drizzle-orm";
import { tokens, agents, type Db } from "@getrelai/db";
import { hashToken, looksLikeAgentToken, secretsMatch } from "../lib/tokens.js";

type Agent = typeof agents.$inferSelect;

declare module "fastify" {
  interface FastifyRequest {
    agent?: Agent;
    // Which token row authenticated this request. A client that got its
    // credential from a rotation already knows this id, but one minted at
    // registration or invite acceptance never sees it, and only the server can
    // map a presented plaintext back to a row. GET /agents/:id/tokens uses it
    // to mark the row the caller holds so an operator does not revoke it.
    tokenId?: string;
    // Which tenant this request acts for. TWO sources, and readers must not
    // assume the first: (a) SERVICE_ADMIN_TOKEN plus an X-Owner-Id header, the
    // dashboard acting for a signed-in person, where `agent` is unset; (b) a
    // per-agent token whose row carries `tokens.ownerId`, the super agent,
    // where `agent` IS set. Unset on the legacy API_SECRET path.
    //
    // THE INVARIANT EVERY CALLSITE MUST HOLD: test `request.agent` before
    // `request.ownerId`. Reading `if (request.ownerId)` as "this is the trusted
    // dashboard" was true until 2026-09-23 and is now false; one route made
    // that assumption and returned owner webhook secrets to an agent.
    ownerId?: string;
  }
}

// Per-process, so the stamp throttle below needs no extra read.
const lastStamped = new Map<string, number>();

const authPlugin: FastifyPluginAsync<{ db: Db }> = async (fastify, { db }) => {
  fastify.decorateRequest("agent");
  fastify.decorateRequest("ownerId");

  // Endpoints that authenticate via their request body (e.g. invite codes)
  // and therefore must be reachable without a bearer token.
  const PUBLIC_PATHS = new Set<string>([
    "/auth/accept-invite",
    "/auth/device/start",
    "/auth/device/token",
    "/livez",
  ]);

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
      request.tokenId = row.token.id;
      // Scope from the ROW, never from a header. X-Owner-Id is deliberately not
      // consulted here: a token that carries its own owner cannot name a
      // different one, which is the whole difference between a control and a
      // convention. Null on every ordinary repo-scoped token, which leaves
      // request.ownerId unset and every downstream check exactly as it was.
      if (row.token.ownerId) request.ownerId = row.token.ownerId;
      // Any authenticated request marks the agent online, not just /heartbeat.
      // Keep these awaited: un-awaited, they leak a pooled connection per call.
      const now = Date.now();
      const interval = Number(process.env.AUTH_STAMP_INTERVAL_MS ?? 60_000);
      // Keyed on the token, not the agent: keyed on the agent, one busy token
      // kept the window warm and its siblings were never stamped however often
      // they authenticated, so GET /agents/:id/tokens reported a credential in
      // active use as never used.
      if (now - (lastStamped.get(row.token.id) ?? 0) >= interval) {
        lastStamped.set(row.token.id, now);
        const at = new Date(now);
        try {
          await db.update(tokens).set({ lastUsedAt: at }).where(eq(tokens.id, row.token.id));
          await db.update(agents).set({ lastSeenAt: at }).where(eq(agents.id, row.agent.id));
        } catch (err) {
          lastStamped.delete(row.token.id);
          request.log.warn({ err }, "failed to stamp agent activity");
        }
      }
      return;
    }

    if (secretsMatch(token, process.env.SERVICE_ADMIN_TOKEN)) {
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

    if (secretsMatch(token, process.env.API_SECRET)) {
      // Legacy shared-secret fallback. Deprecated — issue per-agent tokens instead.
      return;
    }

    return reply.status(401).send({ error: { code: "unauthorized", message: "Invalid token" } });
  });
};

export default fp(authPlugin);
