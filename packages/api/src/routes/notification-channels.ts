import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { eq, desc, and, or, inArray } from "drizzle-orm";
import { randomBytes } from "node:crypto";
import { notificationChannels, users, type Db } from "@getrelai/db";
import type { FastifyRequest } from "fastify";
import { newId } from "../lib/id.js";
import { assertAgentAccess, scopedAgentIds } from "../lib/ownership.js";

// A channel is agent- or owner-scoped. Agent channels reuse assertAgentAccess.
// For owner channels: owner-mode callers may touch only their own; the legacy
// API_SECRET path has full access; per-agent callers are denied (404, so we
// don't leak the channel's existence across tenants).
async function assertChannelAccess(
  request: FastifyRequest,
  db: Db,
  channel: typeof notificationChannels.$inferSelect,
): Promise<{ ok: true } | { ok: false; status: 403 | 404 }> {
  if (channel.ownerId) {
    if (request.agent) return { ok: false, status: 404 };
    if (request.ownerId && request.ownerId !== channel.ownerId) return { ok: false, status: 404 };
    return { ok: true };
  }
  const access = await assertAgentAccess(request, db, channel.agentId!);
  return access.ok ? { ok: true } : { ok: false, status: access.status };
}

function generateSecret(): string {
  return `whsec_${randomBytes(32).toString("hex")}`;
}

const webhookConfigSchema = z.object({
  url:     z.string().url(),
  headers: z.record(z.string()).optional(),
});

// Slack Incoming Webhook URL. Delivery posts a human-readable { text }
// summary (see lib/notifications.ts) rather than the raw signed event JSON.
const slackConfigSchema = z.object({
  webhookUrl: z.string().url(),
});

const createSchema = z.discriminatedUnion("kind", [
  z.object({ agentId: z.string().optional(), ownerId: z.string().optional(), kind: z.literal("webhook"), config: webhookConfigSchema }),
  z.object({ agentId: z.string().optional(), ownerId: z.string().optional(), kind: z.literal("slack"),   config: slackConfigSchema }),
]);

const updateSchema = z.object({
  config:           z.union([webhookConfigSchema, slackConfigSchema]).optional(),
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

    // Owner-scoped channel: an owner-mode caller with no agentId, or the
    // legacy/admin path with an explicit ownerId. Fires on attention-transition
    // events across the owner's repos (see lib/notifications.ts). Never
    // available to a per-agent caller — otherwise a worker could point an
    // owner's notifications at an arbitrary URL by passing someone's ownerId.
    const explicitOwner = body.data.ownerId;
    if (!request.agent && !body.data.agentId && (explicitOwner || request.ownerId)) {
      const ownerId = explicitOwner ?? request.ownerId!;
      if (request.ownerId && ownerId !== request.ownerId) {
        return reply.status(403).send({ error: { code: "forbidden", message: "Cannot create a channel for another owner" } });
      }
      const [owner] = await db.select({ id: users.id }).from(users).where(eq(users.id, ownerId));
      if (!owner) return reply.status(404).send({ error: { code: "not_found", message: "Owner not found" } });

      const [row] = await db.insert(notificationChannels).values({
        id:      newId("nch"),
        ownerId,
        kind:    body.data.kind,
        config:  body.data.config,
        secret:  generateSecret(),
      }).returning();
      return reply.status(201).send({ data: row });
    }

    const agentId = body.data.agentId ?? request.agent?.id;
    if (!agentId) return reply.status(400).send({ error: { code: "validation_error", message: "agentId or ownerId required" } });

    const access = await assertAgentAccess(request, db, agentId);
    if (!access.ok) return reply.status(access.status).send({ error: { code: "not_found", message: "Agent not found" } });

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
    // Owner-mode. With an explicit ?agentId= filter, preserve the existing
    // per-agent behavior (that agent's channels only, and only if it's the
    // owner's — else empty). With no filter, return the owner's own channels
    // plus all their agents' channels.
    if (request.ownerId) {
      const visible = (await scopedAgentIds(request, db)) ?? [];
      const requestedAgentId = request.query.agentId;
      if (requestedAgentId) {
        if (!visible.includes(requestedAgentId)) return { data: [] };
        const rows = await db
          .select()
          .from(notificationChannels)
          .where(eq(notificationChannels.agentId, requestedAgentId))
          .orderBy(desc(notificationChannels.createdAt));
        return { data: rows };
      }
      const conds = [eq(notificationChannels.ownerId, request.ownerId)];
      if (visible.length > 0) conds.push(inArray(notificationChannels.agentId, visible));
      const rows = await db
        .select()
        .from(notificationChannels)
        .where(conds.length === 1 ? conds[0] : or(...conds))
        .orderBy(desc(notificationChannels.createdAt));
      return { data: rows };
    }

    const visible = await scopedAgentIds(request, db);
    const agentId = request.query.agentId ?? request.agent?.id;

    if (visible !== null) {
      if (visible.length === 0) return { data: [] };
      const filter = agentId
        ? (visible.includes(agentId) ? eq(notificationChannels.agentId, agentId) : null)
        : inArray(notificationChannels.agentId, visible);
      if (filter === null) return { data: [] };
      const rows = await db.select().from(notificationChannels).where(filter).orderBy(desc(notificationChannels.createdAt));
      return { data: rows };
    }

    // Legacy API_SECRET — full visibility.
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

    const [existing] = await db.select().from(notificationChannels).where(eq(notificationChannels.id, request.params.id));
    if (!existing) return reply.status(404).send({ error: { code: "not_found", message: "Channel not found" } });
    const access = await assertChannelAccess(request, db, existing);
    if (!access.ok) return reply.status(access.status).send({ error: { code: "not_found", message: "Channel not found" } });

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
    const [existing] = await db.select().from(notificationChannels).where(eq(notificationChannels.id, request.params.id));
    if (!existing) return reply.status(404).send({ error: { code: "not_found", message: "Channel not found" } });
    const access = await assertChannelAccess(request, db, existing);
    if (!access.ok) return reply.status(access.status).send({ error: { code: "not_found", message: "Channel not found" } });

    await db.delete(notificationChannels).where(eq(notificationChannels.id, request.params.id));
    return reply.status(204).send();
  });
};
