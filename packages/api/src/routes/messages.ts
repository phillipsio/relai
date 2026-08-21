import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { eq, sql, asc, desc, count } from "drizzle-orm";
import { messages, threads, tasks, agents } from "@getrelai/db";
import { newId } from "../lib/id.js";
import { publish, ensureSubscription } from "../lib/events.js";
import { assertRepoAccess, peerRepoIds, loadThreadScoped } from "../lib/ownership.js";
import { ensureDmThread, dmThreadFilter } from "../lib/dm.js";
import { clip, clipMetadata } from "../lib/payload.js";
import type { Db } from "@getrelai/db";


// A triage index, not the archive. The cap is safe only because every row
// carries the threadId to drill in with via GET /threads/:id/messages.
const UNREAD_LIMIT      = Number(process.env.UNREAD_LIMIT ?? 20);
const UNREAD_BODY_CHARS = Number(process.env.UNREAD_BODY_CHARS ?? 600);
const UNREAD_META_CHARS = Number(process.env.UNREAD_META_CHARS ?? 300);

const createSchema = z.object({
  // Ignored for agent callers (the token is the identity) and required only on
  // the deprecated shared-secret path, which has no caller identity to derive.
  fromAgent: z.string().optional(),
  toAgent:   z.string().optional(),
  type:      z.enum(["status", "handoff", "finding", "decision", "question", "escalation", "reply"]),
  body:      z.string().min(1),
  metadata:  z.record(z.unknown()).default({}),
  // Opt-in: when true AND type=escalation AND the message loop is off, the
  // legacy fallback spawns a parked high-priority task from this message.
  // Defaults false so informational escalations (e.g. coordinator notifications)
  // don't silently create tasks.
  spawnTask: z.boolean().optional().default(false),
});

export const messageRoutes: FastifyPluginAsync<{ db: Db }> = async (fastify, { db }) => {
  fastify.post<{ Params: { id: string } }>("/threads/:id/messages", async (request, reply) => {
    const body = createSchema.safeParse(request.body);
    if (!body.success) return reply.status(400).send({ error: { code: "validation_error", message: body.error.message } });

    const scope = await loadThreadScoped(request, db, request.params.id);
    if (!scope.ok) return reply.status(scope.status).send({ error: { code: "not_found", message: "Thread not found" } });

    // Refused rather than silently corrected, so a spoof attempt surfaces
    // instead of looking to the caller like a successful post.
    let fromAgent: string;
    let authorKind: "agent" | "human";
    if (request.agent) {
      if (body.data.fromAgent && body.data.fromAgent !== request.agent.id) {
        return reply.status(403).send({
          error: { code: "forbidden", message: "fromAgent must match the authenticated agent" },
        });
      }
      fromAgent  = request.agent.id;
      authorKind = "agent";
    } else if (request.ownerId) {
      fromAgent  = "human";
      authorKind = "human";
    } else {
      // Deprecated shared-secret path. It already grants unfiltered access, so
      // naming a sender is not an escalation, and the seed scripts depend on it.
      if (!body.data.fromAgent) {
        return reply.status(400).send({
          error: { code: "validation_error", message: "fromAgent is required on the shared-secret path" },
        });
      }
      fromAgent  = body.data.fromAgent;
      authorKind = fromAgent === "human" ? "human" : "agent";
    }

    const [message] = await db.insert(messages).values({
      id:        newId("msg"),
      threadId:  request.params.id,
      fromAgent,
      authorKind,
      toAgent:   body.data.toAgent,
      type:      body.data.type,
      body:      body.data.body,
      metadata:  body.data.metadata,
    }).returning();

    // Escalations: OPT-IN auto-create of a high-priority pending task (set
    // spawnTask:true). The scheduler routes it. When ENABLE_MESSAGE_ROUTING is
    // on, the in-API message loop owns the escalation lifecycle, so skip here to
    // avoid a duplicate. Default (spawnTask omitted/false) creates no task —
    // escalation is then purely a notification, so coordinator/informational
    // escalations don't spawn stray tasks.
    const messageLoopOwnsEscalation =
      process.env.ENABLE_MESSAGE_ROUTING === "true" || process.env.ENABLE_MESSAGE_ROUTING === "1";
    if (body.data.type === "escalation" && body.data.spawnTask && !messageLoopOwnsEscalation) {
      const [thread] = await db.select().from(threads).where(eq(threads.id, request.params.id));
      if (thread) {
        await db.insert(tasks).values({
          id:             newId("task"),
          repoId:      thread.repoId,
          title:          body.data.body.trimStart().slice(0, 80).trimEnd(),
          description:    body.data.body,
          priority:       "urgent",
          domains:        [],
          specialization: "architect",
          createdBy:      fromAgent,
          metadata: {
            escalationThreadId:  request.params.id,
            escalationMessageId: message.id,
            escalatedFrom:       fromAgent,
          },
        });
      }
    }

    // Auto-subscribe sender + recipient (if any) to the thread. "human" (the
    // owner path) has no agent row — subscriptions.agentId is an FK — so skip
    // it; the owner reads via polling, not SSE.
    if (fromAgent !== "human") {
      await ensureSubscription(db, fromAgent, "thread", request.params.id);
    }
    if (body.data.toAgent) {
      await ensureSubscription(db, body.data.toAgent, "thread", request.params.id);
    }

    const [thread] = await db.select().from(threads).where(eq(threads.id, request.params.id));
    await publish(db, {
      id:         newId("evt"),
      kind:       "message.posted",
      repoId:  thread?.repoId ?? "",
      targetType: "thread",
      targetId:   request.params.id,
      alsoNotify: body.data.toAgent
        ? [{ targetType: "agent", targetId: body.data.toAgent }]
        : [],
      actorId:    request.agent?.id,
      payload:    { message },
      createdAt:  message.createdAt.toISOString(),
    });

    return reply.status(201).send({ data: message });
  });

  fastify.get<{ Params: { id: string } }>("/threads/:id/messages", async (request, reply) => {
    const scope = await loadThreadScoped(request, db, request.params.id);
    if (!scope.ok) return reply.status(scope.status).send({ error: { code: "not_found", message: "Thread not found" } });
    const rows = await db.select().from(messages).where(eq(messages.threadId, request.params.id)).orderBy(asc(messages.createdAt));
    return { data: rows };
  });

  fastify.put<{ Params: { id: string }; Body: { agentId: string } }>(
    "/threads/:id/messages/read",
    async (request, reply) => {
      const { agentId } = request.body as { agentId: string };
      if (!agentId) return reply.status(400).send({ error: { code: "validation_error", message: "agentId required" } });
      // Marking someone else's messages read suppresses their inbox, so a
      // per-agent caller may only name itself. Admin/owner callers (CLI,
      // dashboard) still pass an explicit id.
      if (request.agent && agentId !== request.agent.id) {
        return reply.status(403).send({ error: { code: "forbidden", message: "Cannot mark messages read for another agent" } });
      }

      const scope = await loadThreadScoped(request, db, request.params.id);
      if (!scope.ok) return reply.status(scope.status).send({ error: { code: "not_found", message: "Thread not found" } });

      await db
        .update(messages)
        .set({ readBy: sql`array_append(read_by, ${agentId})` })
        .where(eq(messages.threadId, request.params.id));

      return { ok: true };
    }
  );

  const dmSchema = z.object({
    type:     z.enum(["status", "handoff", "finding", "decision", "question", "escalation", "reply"]).default("question"),
    body:     z.string().min(1),
    metadata: z.record(z.unknown()).default({}),
  });

  // Per-agent callers only: the pair key needs two agent identities.
  fastify.post<{ Params: { id: string } }>("/agents/:id/messages", async (request, reply) => {
    const body = dmSchema.safeParse(request.body);
    if (!body.success) return reply.status(400).send({ error: { code: "validation_error", message: body.error.message } });

    const sender = request.agent;
    if (!sender) {
      return reply.status(403).send({ error: { code: "forbidden", message: "Direct messages require a per-agent token" } });
    }
    if (request.params.id === sender.id) {
      return reply.status(400).send({ error: { code: "validation_error", message: "Cannot direct-message yourself" } });
    }

    const [recipient] = await db.select().from(agents).where(eq(agents.id, request.params.id));
    const reachable = recipient && (await peerRepoIds(db, sender)).includes(recipient.repoId);
    if (!reachable) return reply.status(404).send({ error: { code: "not_found", message: "Agent not found" } });

    const thread = await ensureDmThread(db, sender.id, recipient.id, sender.repoId);

    const [message] = await db.insert(messages).values({
      id:         newId("msg"),
      threadId:   thread.id,
      fromAgent:  sender.id,
      authorKind: "agent",
      toAgent:    recipient.id,
      type:       body.data.type,
      body:       body.data.body,
      metadata:   body.data.metadata,
    }).returning();

    await ensureSubscription(db, sender.id, "thread", thread.id);
    await ensureSubscription(db, recipient.id, "thread", thread.id);

    await publish(db, {
      id:         newId("evt"),
      kind:       "message.posted",
      repoId:     thread.repoId,
      targetType: "thread",
      targetId:   thread.id,
      alsoNotify: [{ targetType: "agent", targetId: recipient.id }],
      actorId:    sender.id,
      payload:    { message },
      createdAt:  message.createdAt.toISOString(),
    });

    return reply.status(201).send({ data: { threadId: thread.id, message } });
  });

  fastify.get<{ Querystring: { agentId: string; repoId: string } }>("/messages/unread", async (request, reply) => {
    const { agentId, repoId } = request.query;
    if (!agentId)   return reply.status(400).send({ error: { code: "validation_error", message: "agentId required" } });
    if (!repoId) return reply.status(400).send({ error: { code: "validation_error", message: "repoId required" } });
    if (request.agent && agentId !== request.agent.id) {
      return reply.status(403).send({ error: { code: "forbidden", message: "Cannot read another agent's unread feed" } });
    }

    const access = await assertRepoAccess(request, db, repoId);
    if (!access.ok) return reply.status(access.status).send({ error: { code: access.status === 403 ? "forbidden" : "not_found", message: "Repo not found" } });

    const where = sql`(${threads.repoId} = ${repoId} OR ${dmThreadFilter(agentId)}) AND NOT (${messages.readBy} @> ARRAY[${agentId}]::text[])`;

    const [{ value: total }] = await db
      .select({ value: count() })
      .from(messages)
      .innerJoin(threads, eq(messages.threadId, threads.id))
      .where(where);

    // Ordered because it is capped, and newest-first because that is what the
    // MCP inbox notifier and a triaging agent both want from a backlog.
    const rows = await db
      .select({ messages })
      .from(messages)
      .innerJoin(threads, eq(messages.threadId, threads.id))
      .where(where)
      .orderBy(desc(messages.createdAt))
      .limit(UNREAD_LIMIT);

    const data = rows.map(({ messages: m }) => {
      const body = clip(m.body, UNREAD_BODY_CHARS);
      return {
        ...m,
        body: body.text,
        metadata: clipMetadata(m.metadata, UNREAD_META_CHARS),
        ...(body.truncated ? { truncated: true, bodyLength: m.body.length } : {}),
      };
    });

    return { data, meta: { total, returned: data.length } };
  });
};
