import type { FastifyPluginAsync } from "fastify";
import { eq, and, sql, inArray, desc, isNull } from "drizzle-orm";
import {
  repos, tasks, threads, messages, subscriptions, events,
  type Db,
} from "@getrelai/db";
import { humanizeTaskStatus } from "@getrelai/types";

// How many recent events the snapshot carries. Kept small (and each event
// trimmed to a one-line summary, below) because this is the dominant
// contributor to session_start payload size in an active repo.
const RECENT_EVENTS_LIMIT = Number(process.env.SESSION_RECENT_EVENTS_LIMIT ?? 20);

// Collapse an event's full payload (task bodies, multi-paragraph review notes,
// message bodies) into a one-line summary so recentEvents stays a cheap "what
// happened" feed. Agents fetch full detail by id when they need it.
function summarizeEvent(kind: string, payload: Record<string, unknown>): string {
  if (kind === "message.posted") {
    const m = payload.message as { type?: string; fromAgent?: string; body?: string } | undefined;
    const body = (m?.body ?? "").replace(/\s+/g, " ").trim().slice(0, 140);
    return `${m?.type ?? "message"} from ${m?.fromAgent ?? "?"}: ${body}`;
  }
  if (kind.startsWith("task.")) {
    const t = payload.task as { title?: string; status?: string } | undefined;
    if (t) return `${t.title ?? "task"} (${t.status ?? "?"})`;
  }
  if (kind.startsWith("thread.")) {
    const th = payload.thread as { title?: string } | undefined;
    if (th) return th.title ?? "thread";
  }
  return kind;
}

// One bundled snapshot for "where am I" — replaces the 4-5 calls a fresh agent
// otherwise makes (my tasks, unread messages, open threads, project context).
// Caller is identified from request.agent; the legacy API_SECRET fallback can't
// resolve an identity and is rejected.
export const sessionRoutes: FastifyPluginAsync<{ db: Db }> = async (fastify, { db }) => {
  fastify.get<{ Querystring: { repoId?: string } }>("/session/start", async (request, reply) => {
    const agent = request.agent;
    if (!agent) {
      return reply.status(403).send({
        error: { code: "forbidden", message: "Session start requires a per-agent token" },
      });
    }

    const repoId = request.query.repoId ?? agent.repoId;
    if (repoId !== agent.repoId) {
      return reply.status(403).send({
        error: { code: "forbidden", message: "Agent is not a member of this repo" },
      });
    }

    const [project] = await db.select().from(repos).where(eq(repos.id, repoId));
    if (!project) {
      return reply.status(404).send({ error: { code: "not_found", message: "Repo not found" } });
    }

    // My open tasks — anything not yet completed/cancelled assigned to me.
    const myTasks = await db
      .select()
      .from(tasks)
      .where(and(
        eq(tasks.repoId, repoId),
        eq(tasks.assignedTo, agent.id),
        inArray(tasks.status, ["pending", "assigned", "in_progress", "blocked"]),
        isNull(tasks.archivedAt),
      ))
      .orderBy(desc(tasks.updatedAt));

    const tasksWithLabels = myTasks.map((t) => ({
      ...t,
      humanLabel: humanizeTaskStatus(t),
    }));

    // Unread messages addressed to my project (any thread I can see).
    const unreadRows = await db
      .select({ messages })
      .from(messages)
      .innerJoin(threads, eq(messages.threadId, threads.id))
      .where(sql`${threads.repoId} = ${repoId} AND NOT (${messages.readBy} @> ARRAY[${agent.id}]::text[])`);
    const unreadMessages = unreadRows.map((r) => r.messages);

    // Open threads I'm subscribed to in this project.
    const openThreads = await db
      .select({
        id:           threads.id,
        title:        threads.title,
        repoId:    threads.repoId,
        type:         threads.type,
        status:       threads.status,
        summary:      threads.summary,
        createdAt:    threads.createdAt,
      })
      .from(threads)
      .innerJoin(subscriptions, and(
        eq(subscriptions.targetType, "thread"),
        eq(subscriptions.targetId,   threads.id),
        eq(subscriptions.agentId,    agent.id),
      ))
      .where(and(eq(threads.repoId, repoId), eq(threads.status, "open"), isNull(threads.archivedAt)));

    // Recent events the agent should care about: anything in this project
    // whose primary target matches one of their subscriptions, or whose
    // alsoNotify list names them directly. Newest first, capped, and each
    // collapsed to a one-line summary (full payloads are fetched by id).
    const recentEventRows = await db
      .select({
        id:         events.id,
        kind:       events.kind,
        targetType: events.targetType,
        targetId:   events.targetId,
        payload:    events.payload,
        createdAt:  events.createdAt,
      })
      .from(events)
      .where(sql`
        ${events.repoId} = ${repoId}
        AND (
          EXISTS (
            SELECT 1 FROM ${subscriptions}
            WHERE ${subscriptions.agentId} = ${agent.id}
              AND ${subscriptions.targetType}::text = ${events.targetType}
              AND ${subscriptions.targetId} = ${events.targetId}
          )
          OR ${events.alsoNotify} @> ${JSON.stringify([{ targetType: "agent", targetId: agent.id }])}::jsonb
        )
      `)
      .orderBy(desc(events.createdAt))
      .limit(RECENT_EVENTS_LIMIT);

    const recentEvents = recentEventRows.map(({ payload, ...e }) => ({
      ...e,
      summary: summarizeEvent(e.kind, (payload ?? {}) as Record<string, unknown>),
    }));

    return {
      data: {
        agent: {
          id:             agent.id,
          name:           agent.name,
          specialization: agent.specialization,
          workerType:     agent.workerType,
          repoPath:       agent.repoPath,
        },
        repo: {
          id:              project.id,
          name:            project.name,
          context:         project.context,
          defaultAssignee: project.defaultAssignee,
        },
        tasks:          tasksWithLabels,
        unreadMessages,
        openThreads,
        recentEvents,
      },
    };
  });
};
