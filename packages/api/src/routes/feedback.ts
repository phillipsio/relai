import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { agents, repos, tasks } from "@getrelai/db";
import { newId } from "../lib/id.js";
import { publish, ensureSubscription } from "../lib/events.js";
import type { Db } from "@getrelai/db";

const feedbackSchema = z.object({
  summary:  z.string().min(1).max(200),
  details:  z.string().min(1).max(10_000),
  severity: z.enum(["low", "normal", "high", "critical"]).optional(),
});

// Maps caller-supplied severity to a task priority value.
function toPriority(severity?: string): "low" | "normal" | "high" | "urgent" {
  if (severity === "critical") return "urgent";
  if (severity === "high")     return "high";
  if (severity === "low")      return "low";
  return "normal";
}

export const feedbackRoutes: FastifyPluginAsync<{ db: Db }> = async (fastify, { db }) => {
  // POST /relai-feedback — cross-repo issue report from any authenticated caller.
  // Creates a task in the RELAI_FEEDBACK_REPO_ID repo (disabled when the env var
  // is unset so this doesn't silently activate on every self-hosted install).
  // The caller's own repoId and agentId are tagged in task metadata so the
  // feedback triage team can identify the source without trusting the body.
  fastify.post("/relai-feedback", async (request, reply) => {
    const targetRepoId = process.env.RELAI_FEEDBACK_REPO_ID;
    if (!targetRepoId) {
      return reply.status(501).send({
        error: {
          code: "not_implemented",
          message: "Feedback reporting is disabled on this server (RELAI_FEEDBACK_REPO_ID is not set).",
        },
      });
    }

    const body = feedbackSchema.safeParse(request.body);
    if (!body.success) {
      return reply.status(400).send({ error: { code: "validation_error", message: body.error.message } });
    }

    // Resolve reporter identity for a descriptive title.
    const reporterAgentId = request.agent?.id ?? null;
    const reporterRepoId  = request.agent?.repoId ?? null;

    let agentName = reporterAgentId ?? "owner";
    let repoName  = reporterRepoId  ?? "unknown";

    if (reporterAgentId) {
      const [agentRow] = await db.select({ name: agents.name }).from(agents).where(eq(agents.id, reporterAgentId));
      if (agentRow) agentName = agentRow.name;
    }
    if (reporterRepoId) {
      const [repoRow] = await db.select({ name: repos.name }).from(repos).where(eq(repos.id, reporterRepoId));
      if (repoRow) repoName = repoRow.name;
    }

    const title = `Feedback from ${agentName} in ${repoName}: ${body.data.summary}`;
    const createdBy = reporterAgentId ?? (request as any).ownerId ?? "system";

    const [task] = await db.insert(tasks).values({
      id:          newId("task"),
      repoId:      targetRepoId,
      createdBy,
      title,
      description: body.data.details,
      status:      "pending",
      priority:    toPriority(body.data.severity),
      domains:     ["feedback"],
      metadata:    {
        feedback: {
          reporterAgentId,
          reporterRepoId,
          severity:   body.data.severity ?? "normal",
          reportedAt: new Date().toISOString(),
        },
      },
      blockedBy: [],
    }).returning();

    // Subscribe the reporter so they get status updates if they're polling the
    // feedback repo (e.g. a cross-repo SSE connection). Best-effort only.
    if (reporterAgentId) {
      await ensureSubscription(db, reporterAgentId, "task", task.id).catch(() => {});
    }

    await publish(db, {
      id:         newId("evt"),
      kind:       "task.created",
      repoId:     targetRepoId,
      targetType: "task",
      targetId:   task.id,
      alsoNotify: [],
      actorId:    reporterAgentId ?? undefined,
      payload:    { task },
      createdAt:  task.createdAt.toISOString(),
    });

    return reply.status(201).send({ data: { taskId: task.id, title, repoId: targetRepoId } });
  });
};
