import type { FastifyPluginAsync } from "fastify";
import { eq, and, sql, inArray, desc, isNull, max, count } from "drizzle-orm";
import {
  repos, tasks, threads, messages, subscriptions, events,
  artifacts, artifactVersions, artifactReads,
  type Db,
} from "@getrelai/db";
import { humanizeTaskStatus } from "@getrelai/types";
import { dmThreadFilter, dmEventFilter } from "../lib/dm.js";

// How many recent events the snapshot carries. Kept small (and each event
// trimmed to a one-line summary, below) because this is the dominant
// contributor to session_start payload size in an active repo.
const RECENT_EVENTS_LIMIT = Number(process.env.SESSION_RECENT_EVENTS_LIMIT ?? 20);

// An index of what exists, not the content: get_unread_messages, get_my_tasks
// and GET /tasks/:id serve the full text, and the prompt calls them anyway.
const UNREAD_LIMIT     = Number(process.env.SESSION_UNREAD_LIMIT ?? 20);
const TASK_LIMIT       = Number(process.env.SESSION_TASK_LIMIT ?? 10);
const THREAD_LIMIT     = Number(process.env.SESSION_THREAD_LIMIT ?? 25);
const BODY_CHARS       = Number(process.env.SESSION_BODY_CHARS ?? 300);
const TASK_DESC_CHARS  = Number(process.env.SESSION_TASK_DESC_CHARS ?? 500);
const TASK_META_CHARS  = Number(process.env.SESSION_TASK_META_CHARS ?? 800);
const MSG_META_CHARS   = Number(process.env.SESSION_MSG_META_CHARS ?? 300);

// Truncation is always declared. An agent that cannot tell a clipped body from
// a whole one will quote the clipped one as if it were complete.
function clip(text: string, limit: number): { text: string; truncated: boolean } {
  if (text.length <= limit) return { text, truncated: false };
  return { text: text.slice(0, limit) + "…", truncated: true };
}

// Small metadata passes through untouched. That is the common case, and a
// follow-up call to recover `{ branchName, roundNumber }` would be absurd.
function clipMetadata(metadata: unknown, limit = TASK_META_CHARS): unknown {
  if (!metadata || typeof metadata !== "object") return metadata;
  if (JSON.stringify(metadata).length <= limit) return metadata;
  return { _truncated: true, keys: Object.keys(metadata as Record<string, unknown>) };
}

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
      .orderBy(desc(tasks.updatedAt))
      .limit(TASK_LIMIT);

    const [{ value: taskCount }] = await db
      .select({ value: count() })
      .from(tasks)
      .where(and(
        eq(tasks.repoId, repoId),
        eq(tasks.assignedTo, agent.id),
        inArray(tasks.status, ["pending", "assigned", "in_progress", "blocked"]),
        isNull(tasks.archivedAt),
      ));

    const tasksWithLabels = myTasks.map((t) => {
      const desc = clip(t.description, TASK_DESC_CHARS);
      return {
        ...t,
        description:    desc.text,
        metadata:       clipMetadata(t.metadata),
        humanLabel:     humanizeTaskStatus(t),
        ...(desc.truncated ? { truncated: true, descriptionLength: t.description.length } : {}),
      };
    });

    // Unread messages addressed to my project (any thread I can see).
    const unreadWhere = sql`(${threads.repoId} = ${repoId} OR ${dmThreadFilter(agent.id)}) AND NOT (${messages.readBy} @> ARRAY[${agent.id}]::text[])`;

    const [{ value: unreadCount }] = await db
      .select({ value: count() })
      .from(messages)
      .innerJoin(threads, eq(messages.threadId, threads.id))
      .where(unreadWhere);

    // Ordered because it is capped: an unordered LIMIT hands back an arbitrary
    // subset of the backlog and calls it the inbox.
    const unreadRows = await db
      .select({ messages })
      .from(messages)
      .innerJoin(threads, eq(messages.threadId, threads.id))
      .where(unreadWhere)
      .orderBy(desc(messages.createdAt))
      .limit(UNREAD_LIMIT);

    const unreadMessages = unreadRows.map(({ messages: m }) => {
      const body = clip(m.body, BODY_CHARS);
      return {
        ...m,
        body: body.text,
        metadata: clipMetadata(m.metadata, MSG_META_CHARS),
        ...(body.truncated ? { truncated: true, bodyLength: m.body.length } : {}),
      };
    });

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
      .where(and(eq(threads.repoId, repoId), eq(threads.status, "open"), isNull(threads.archivedAt)))
      .orderBy(desc(threads.createdAt))
      .limit(THREAD_LIMIT);

    const [{ value: openThreadCount }] = await db
      .select({ value: count() })
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
        (${events.repoId} = ${repoId} OR ${dmEventFilter(agent.id, events.targetType, events.targetId)})
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

    // Artifacts this agent has pulled that have moved on since. Derived from the
    // recorded read rather than from events, so a publisher shipping five
    // versions leaves one item here instead of five notifications to coalesce.
    const readRows = await db
      .select({
        artifactId: artifactReads.artifactId,
        readVersion: artifactReads.version,
        name: artifacts.name,
        repoId: artifacts.repoId,
      })
      .from(artifactReads)
      .innerJoin(artifacts, eq(artifacts.id, artifactReads.artifactId))
      .where(and(eq(artifactReads.agentId, agent.id), eq(artifacts.repoId, project.id)));

    const staleArtifacts = (await Promise.all(readRows.map(async (r) => {
      const [{ value }] = await db
        .select({ value: max(artifactVersions.version) })
        .from(artifactVersions)
        .where(eq(artifactVersions.artifactId, r.artifactId));
      const current = value ?? 0;
      return current > r.readVersion
        ? { name: r.name, readVersion: r.readVersion, currentVersion: current }
        : null;
    }))).filter((x): x is NonNullable<typeof x> => x !== null);

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
        taskCount,
        unreadMessages,
        unreadCount,
        openThreads,
        openThreadCount,
        recentEvents,
        staleArtifacts,
      },
    };
  });
};
