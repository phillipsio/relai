import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { routingLog } from "@getrelai/db";
import { newId } from "../lib/id.js";
import type { Db } from "@getrelai/db";

const createSchema = z.object({
  taskId:     z.string(),
  assignedTo: z.string(),
  method:     z.enum(["rules", "claude"]),
  rationale:  z.string(),
});

export const routingLogRoutes: FastifyPluginAsync<{ db: Db }> = async (fastify, { db }) => {
  fastify.post("/routing-log", async (request, reply) => {
    const body = createSchema.safeParse(request.body);
    if (!body.success) return reply.status(400).send({ error: { code: "validation_error", message: body.error.message } });

    const [entry] = await db.insert(routingLog).values({
      id:         newId("rlog"),
      taskId:     body.data.taskId,
      assignedTo: body.data.assignedTo,
      method:     body.data.method,
      rationale:  body.data.rationale,
    }).returning();

    return reply.status(201).send({ data: entry });
  });

  fastify.get<{ Querystring: { taskId?: string; assignedTo?: string } }>(
    "/routing-log",
    async (request, reply) => {
      const { taskId, assignedTo } = request.query;

      const rows = taskId
        ? await db.select().from(routingLog).where(eq(routingLog.taskId, taskId))
        : assignedTo
        ? await db.select().from(routingLog).where(eq(routingLog.assignedTo, assignedTo))
        : await db.select().from(routingLog);

      return { data: rows };
    }
  );
};
