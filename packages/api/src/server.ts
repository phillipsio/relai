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
import { artifactRoutes } from "./routes/artifacts.js";
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

export const BODY_LIMIT_BYTES = 1024 * 1024;

export function buildServer({ logger = true, scheduler = true }: { logger?: boolean; scheduler?: boolean } = {}) {
  const db = createDb(process.env.DATABASE_URL!);

  // Explicit rather than inherited: Fastify's default is 1 MiB, and a limit that
  // rejects a request before Zod or any handler runs deserves to be a decision.
  // Kept at 1 MiB — task descriptions and handoff messages are the largest
  // legitimate payloads and sit orders of magnitude below it, while stored text
  // has no other ceiling (the only precedent is the verify executor's 8KB
  // stdout cap). Raise it deliberately if a document-shaped feature lands.
  const fastify = Fastify({ logger, bodyLimit: BODY_LIMIT_BYTES });

  fastify.register(cors, { origin: true });
  fastify.register(sensible);
  fastify.register(authPlugin, { db });

  fastify.register(repoRoutes, { db });
  fastify.register(agentRoutes, { db });
  fastify.register(tokenRoutes, { db });
  fastify.register(inviteRoutes, { db });
  fastify.register(artifactRoutes, { db });
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
