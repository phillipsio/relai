import Fastify from "fastify";
import cors from "@fastify/cors";
import sensible from "@fastify/sensible";
import { createDb } from "@relai/db";
import authPlugin from "./plugins/auth.js";
import { projectRoutes } from "./routes/projects.js";
import { agentRoutes } from "./routes/agents.js";
import { taskRoutes } from "./routes/tasks.js";
import { threadRoutes } from "./routes/threads.js";
import { messageRoutes } from "./routes/messages.js";
import { routingLogRoutes } from "./routes/routing-log.js";
import { startRoutingScheduler } from "./lib/router/scheduler.js";

export function buildServer({ logger = true, scheduler = true }: { logger?: boolean; scheduler?: boolean } = {}) {
  const db = createDb(process.env.DATABASE_URL!);

  const fastify = Fastify({ logger });

  fastify.register(cors, { origin: true });
  fastify.register(sensible);
  fastify.register(authPlugin);

  fastify.register(projectRoutes, { db });
  fastify.register(agentRoutes, { db });
  fastify.register(taskRoutes, { db });
  fastify.register(threadRoutes, { db });
  fastify.register(messageRoutes, { db });
  fastify.register(routingLogRoutes, { db });

  fastify.get("/health", async () => ({ ok: true }));

  // Start background routing scheduler (disabled in tests)
  if (scheduler) {
    fastify.addHook("onReady", async () => {
      startRoutingScheduler(db);
    });
  }

  return fastify;
}
