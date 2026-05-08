import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { eq, desc } from "drizzle-orm";
import { randomBytes } from "node:crypto";
import { notificationChannels, type Db } from "@getrelai/db";
import { newId } from "../lib/id.js";

function generateSecret(): string {
  return `whsec_${randomBytes(32).toString("hex")}`;
}

const webhookConfigSchema = z.object({
  url:     z.string().url(),
  headers: z.record(z.string()).optional(),
});

const createSchema = z.object({
  agentId: z.string().optional(),  // defaults to caller
  kind:    z.literal("webhook"),
  config:  webhookConfigSchema,
});

const updateSchema = z.object({
  config:           webhookConfigSchema.optional(),
  // Setting `disabled: false` clears `disabledAt` and resets failureCount —
  // the operator's "I fixed the URL, try again" lever after a circuit trip.
  disabled:         z.boolean().optional(),
  // Rotate the HMAC secret. Returns the new secret on the response row so the
  // operator can copy it into their receiver. Old secret is overwritten — any
  // in-flight retries against the old secret will start failing verification.
  regenerateSecret: z.boolean().optional(),
});

export const notificationChannelRoutes: FastifyPluginAsync<{ db: Db }> = async (fastify, { db }) => {
  fastify.post("/notification-channels", async (request, reply) => {
    const body = createSchema.safeParse(request.body);
    if (!body.success) return reply.status(400).send({ error: { code: "validation_error", message: body.error.message } });

    const agentId = body.data.agentId ?? request.agent?.id;
    if (!agentId) return reply.status(400).send({ error: { code: "validation_error", message: "agentId required" } });

    const [row] = await db.insert(notificationChannels).values({
      id:      newId("nch"),
      agentId,
      kind:    body.data.kind,
      config:  body.data.config,
      secret:  generateSecret(),
    }).returning();

    return reply.status(201).send({ data: row });
  });

  fastify.get<{ Querystring: { agentId?: string } }>("/notification-channels", async (request) => {
    const agentId = request.query.agentId ?? request.agent?.id;
    if (!agentId) return { data: [] };
    const rows = await db
      .select()
      .from(notificationChannels)
      .where(eq(notificationChannels.agentId, agentId))
      .orderBy(desc(notificationChannels.createdAt));
    return { data: rows };
  });

  fastify.put<{ Params: { id: string } }>("/notification-channels/:id", async (request, reply) => {
    const body = updateSchema.safeParse(request.body);
    if (!body.success) return reply.status(400).send({ error: { code: "validation_error", message: body.error.message } });

    const patch: Partial<typeof notificationChannels.$inferInsert> = {};
    if (body.data.config !== undefined) patch.config = body.data.config;
    if (body.data.disabled === false) {
      patch.disabledAt   = null;
      patch.failureCount = 0;
      patch.lastError    = null;
    } else if (body.data.disabled === true) {
      patch.disabledAt = new Date();
    }
    if (body.data.regenerateSecret) patch.secret = generateSecret();

    const [row] = await db
      .update(notificationChannels)
      .set(patch)
      .where(eq(notificationChannels.id, request.params.id))
      .returning();

    if (!row) return reply.status(404).send({ error: { code: "not_found", message: "Channel not found" } });
    return { data: row };
  });

  fastify.delete<{ Params: { id: string } }>("/notification-channels/:id", async (request, reply) => {
    const [row] = await db
      .delete(notificationChannels)
      .where(eq(notificationChannels.id, request.params.id))
      .returning();
    if (!row) return reply.status(404).send({ error: { code: "not_found", message: "Channel not found" } });
    return reply.status(204).send();
  });
};
