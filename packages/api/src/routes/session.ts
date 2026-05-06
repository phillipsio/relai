import type { FastifyPluginAsync } from "fastify";
import { eq, and, sql, inArray, desc } from "drizzle-orm";
import {
  projects, tasks, threads, messages, subscriptions, events,
  type Db,
} from "@getrelai/db";
import { humanizeTaskStatus } from "@getrelai/types";

// One bundled snapshot for "where am I" — replaces the 4-5 calls a fresh agent
// otherwise makes (my tasks, unread messages, open threads, project context).
// Caller is identified from request.agent; the legacy API_SECRET fallback can't
// resolve an identity and is rejected.
export const sessionRoutes: FastifyPluginAsync<{ db: Db }> = async (fastify, { db }) => {
  fastify.get<{ Querystring: { projectId?: string } }>("/session/start", async (request, reply) => {
    const agent = request.agent;
    if (!agent) {
      return reply.status(403).send({
        error: { code: "forbidden", message: "Session start requires a per-agent token" },
      });
    }

    const projectId = request.query.projectId ?? agent.projectId;
    if (projectId !== agent.projectId) {
      return reply.status(403).send({
        error: { code: "forbidden", message: "Agent is not a member of this project" },
      });
    }

    const [project] = await db.select().from(projects).where(eq(projects.id, projectId));
    if (!project) {
      return reply.status(404).send({ error: { code: "not_found", message: "Project not found" } });
    }

    // My open tasks — anything not yet completed/cancelled assigned to me.
    const myTasks = await db
      .select()
      .from(tasks)
      .where(and(
        eq(tasks.projectId, projectId),
        eq(tasks.assignedTo, agent.id),
        inArray(tasks.status, ["pending", "assigned", "in_progress", "blocked"]),
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
      .where(sql`${threads.projectId} = ${projectId} AND NOT (${messages.readBy} @> ARRAY[${agent.id}]::text[])`);
    const unreadMessages = unreadRows.map((r) => r.messages);

    // Open threads I'm subscribed to in this project.
    const openThreads = await db
      .select({
        id:           threads.id,
        title:        threads.title,
        projectId:    threads.projectId,
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
      .where(and(eq(threads.projectId, projectId), eq(threads.status, "open")));

    // Recent events the agent should care about: anything in this project
    // whose primary target matches one of their subscriptions, or whose
    // alsoNotify list names them directly. Caps at 50 newest first.
    const recentEvents = await db
      .select()
      .from(events)
      .where(sql`
        ${events.projectId} = ${projectId}
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
      .limit(50);

    return {
      data: {
        agent: {
          id:             agent.id,
          name:           agent.name,
          specialization: agent.specialization,
          workerType:     agent.workerType,
          repoPath:       agent.repoPath,
        },
        project: {
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
