import type { FastifyPluginAsync } from "fastify";
import { bus, resolveSubscribers, deliverableTo, type AppEvent } from "../lib/events.js";
import { tokens, ownerGodAgents, type Db } from "@getrelai/db";
import { and, eq, isNull } from "drizzle-orm";

function heartbeatMs(): number {
  const n = Number(process.env.SSE_HEARTBEAT_MS);
  return Number.isFinite(n) && n >= 100 && n <= 60_000 ? n : 25_000;
}

export const eventRoutes: FastifyPluginAsync<{ db: Db }> = async (fastify, { db }) => {
  fastify.get("/events", async (request, reply) => {
    const agent = request.agent;
    if (!agent) {
      return reply.status(403).send({
        error: { code: "forbidden", message: "Event stream requires a per-agent token (legacy API_SECRET cannot subscribe)" },
      });
    }

    const { tokenId, chainSlotId } = request;
    const credentialLive = async () => {
      if (!tokenId) return false;
      const [row] = await db.select({ id: tokens.id }).from(tokens)
        .where(and(eq(tokens.id, tokenId), isNull(tokens.revokedAt))).limit(1);
      if (!row) return false;
      if (!chainSlotId) return true;
      const [slot] = await db.select({ id: ownerGodAgents.id }).from(ownerGodAgents)
        .where(eq(ownerGodAgents.id, chainSlotId)).limit(1);
      return !!slot;
    };

    reply.raw.writeHead(200, {
      "Content-Type":  "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      "Connection":    "keep-alive",
      "X-Accel-Buffering": "no",
    });
    reply.raw.write(": connected\n\n");

    const close = () => {
      clearInterval(heartbeat);
      bus.off("event", onEvent);
      reply.raw.end();
    };

    let checking = false;
    const heartbeat = setInterval(() => {
      if (checking) return;
      checking = true;
      credentialLive()
        .then((live) => (live ? reply.raw.write(": ping\n\n") : close()))
        .catch((err) => {
          request.log.error({ err }, "SSE credential check failed");
          close();
        })
        .finally(() => { checking = false; });
    }, heartbeatMs());

    const onEvent = async (event: AppEvent) => {
      try {
        const subscribers = await resolveSubscribers(db, event);
        if (!deliverableTo(event, agent.id, subscribers)) return;
        if (!(await credentialLive())) return close();
        reply.raw.write(`event: ${event.kind}\n`);
        reply.raw.write(`id: ${event.id}\n`);
        reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
      } catch (err) {
        request.log.error({ err }, "SSE event delivery failed");
      }
    };

    bus.on("event", onEvent);

    request.raw.on("close", close);

    // Returning a never-resolving promise keeps Fastify from closing the response.
    return new Promise<void>(() => {});
  });
};
