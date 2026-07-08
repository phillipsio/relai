import Fastify from "fastify";
import cors from "@fastify/cors";
import sensible from "@fastify/sensible";
import { sql } from "drizzle-orm";
import { createDb } from "@getrelai/db";
import authPlugin from "./plugins/auth.js";
import { repoRoutes } from "./routes/repos.js";
import { agentRoutes } from "./routes/agents.js";
import { tokenRoutes } from "./routes/tokens.js";
import { inviteRoutes } from "./routes/invites.js";
import { subscriptionRoutes } from "./routes/subscriptions.js";
import { eventRoutes } from "./routes/events.js";
import { taskRoutes } from "./routes/tasks.js";
import { threadRoutes } from "./routes/threads.js";
import { messageRoutes } from "./routes/messages.js";
import { routingLogRoutes } from "./routes/routing-log.js";
import { notificationChannelRoutes } from "./routes/notification-channels.js";
import { sessionRoutes } from "./routes/session.js";
import { feedbackRoutes } from "./routes/feedback.js";
import { startRoutingScheduler } from "./lib/router/scheduler.js";
import { startNotificationDelivery } from "./lib/notifications.js";

export function buildServer({ logger = true, scheduler = true }: { logger?: boolean; scheduler?: boolean } = {}) {
  const db = createDb(process.env.DATABASE_URL!);

  const fastify = Fastify({ logger });

  fastify.register(cors, { origin: true });
  fastify.register(sensible);
  fastify.register(authPlugin, { db });

  fastify.register(repoRoutes, { db });
  fastify.register(agentRoutes, { db });
  fastify.register(tokenRoutes, { db });
  fastify.register(inviteRoutes, { db });
  fastify.register(subscriptionRoutes, { db });
  fastify.register(eventRoutes, { db });
  fastify.register(taskRoutes, { db });
  fastify.register(threadRoutes, { db });
  fastify.register(messageRoutes, { db });
  fastify.register(routingLogRoutes, { db });
  fastify.register(notificationChannelRoutes, { db });
  fastify.register(sessionRoutes, { db });
  fastify.register(feedbackRoutes, { db });

  fastify.get("/health", async () => ({ ok: true }));

  // Unauthenticated readiness probe (in PUBLIC_PATHS) — verifies the process is
  // up AND the DB is reachable, so a monitor can tell "running" from "healthy".
  fastify.get("/livez", async (_request, reply) => {
    try {
      await db.execute(sql`select 1`);
      return { ok: true };
    } catch {
      return reply.status(503).send({ ok: false, error: "db_unreachable" });
    }
  });

  // Start background routing scheduler + notification delivery (disabled in tests)
  if (scheduler) {
    fastify.addHook("onReady", async () => {
      startRoutingScheduler(db);
      startNotificationDelivery(db);
    });
  }

  return fastify;
}
