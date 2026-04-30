import type { FastifyPluginAsync } from "fastify";
import { bus, resolveSubscribers, type AppEvent } from "../lib/events.js";
import type { Db } from "@relai/db";

const HEARTBEAT_MS = 25_000;

export const eventRoutes: FastifyPluginAsync<{ db: Db }> = async (fastify, { db }) => {
  fastify.get("/events", async (request, reply) => {
    const agent = request.agent;
    if (!agent) {
      return reply.status(403).send({
        error: { code: "forbidden", message: "Event stream requires a per-agent token (legacy API_SECRET cannot subscribe)" },
      });
    }

    reply.raw.writeHead(200, {
      "Content-Type":  "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      "Connection":    "keep-alive",
      "X-Accel-Buffering": "no",
    });
    reply.raw.write(": connected\n\n");

    const heartbeat = setInterval(() => {
      reply.raw.write(": ping\n\n");
    }, HEARTBEAT_MS);

    const onEvent = async (event: AppEvent) => {
      try {
        const subscribers = await resolveSubscribers(db, event);
        if (!subscribers.includes(agent.id)) return;
        reply.raw.write(`event: ${event.kind}\n`);
        reply.raw.write(`id: ${event.id}\n`);
        reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
      } catch (err) {
        request.log.error({ err }, "SSE event delivery failed");
      }
    };

    bus.on("event", onEvent);

    request.raw.on("close", () => {
      clearInterval(heartbeat);
      bus.off("event", onEvent);
    });

    // Returning a never-resolving promise keeps Fastify from closing the response.
    return new Promise<void>(() => {});
  });
};
