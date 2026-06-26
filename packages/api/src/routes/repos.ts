import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { eq, inArray, and } from "drizzle-orm";
import { repos, agents, threads, messages, tasks, routingLog, verificationLog, invites } from "@getrelai/db";
import { newId } from "../lib/id.js";
import { assertRepoAccess, scopedRepoFilter } from "../lib/ownership.js";
import type { Db } from "@getrelai/db";

// repoUrl feeds straight into `git ls-remote <repoUrl>` (the git_pushed
// verifyKind). An unrestricted URL lets a worker-controlled value point the
// API host's outbound git at an internal/metadata endpoint (SSRF) via
// file://, http://, etc. Only https/ssh are meaningful remotes anyway.
// Reject `*ssh://` lookalikes (e.g. git+ssh://) and a leading-dash
// hostname/username — modern git already rejects the latter as an
// argument-injection vector (CVE-2017-1000117), but parsing it ourselves
// keeps the API's own validation correct independent of the host's git
// version. new URL() is used (not startsWith) so we validate the actual
// parsed hostname/username, not just the string prefix.
const repoUrlSchema = z.string().url().refine((value) => {
  let url: URL;
  try { url = new URL(value); } catch { return false; }
  if (url.protocol !== "https:" && url.protocol !== "ssh:") return false;
  if (url.hostname.startsWith("-")) return false;
  if (url.username.startsWith("-")) return false;
  return true;
}, { message: "repoUrl must use https:// or ssh:// with a valid hostname (no leading '-')" });

const createSchema = z.object({
  name: z.string().min(1),
  repoUrl: repoUrlSchema.optional(),
  description: z.string().optional(),
  defaultAssignee: z.string().optional(),
  context: z.string().optional(),
});

export const repoRoutes: FastifyPluginAsync<{ db: Db }> = async (fastify, { db }) => {
  fastify.get("/repos", async (request) => {
    // Per-agent callers see only their own project; service-admin sees only
    // repos owned by X-Owner-Id; API_SECRET sees everything.
    if (request.agent) {
      const rows = await db.select().from(repos).where(eq(repos.id, request.agent.repoId));
      return { data: rows };
    }
    const filter = scopedRepoFilter(request);
    const rows = filter
      ? await db.select().from(repos).where(filter)
      : await db.select().from(repos);
    return { data: rows };
  });

  fastify.post("/repos", async (request, reply) => {
    const body = createSchema.safeParse(request.body);
    if (!body.success) return reply.status(400).send({ error: { code: "validation_error", message: body.error.message } });

    // repoUrl drives git_pushed's outbound `git ls-remote` from the API host
    // — restrict who can set it to the same trust tier as task-level shell
    // authorship (orchestrator or the deprecated admin/owner path).
    if (body.data.repoUrl && request.agent && request.agent.role !== "orchestrator") {
      return reply.status(403).send({
        error: { code: "forbidden", message: "Only orchestrator agents may set repoUrl." },
      });
    }

    const [project] = await db.insert(repos).values({
      id: newId("repo"),
      name: body.data.name,
      // Stamp tenant ownership when the closed dashboard provisions a project
      // on behalf of a logged-in user. Null for self-hosted / seed scripts.
      ownerId: request.ownerId ?? null,
      repoUrl: body.data.repoUrl,
      description: body.data.description,
      defaultAssignee: body.data.defaultAssignee ?? null,
      context: body.data.context ?? null,
    }).returning();

    return reply.status(201).send({ data: project });
  });

  fastify.get<{ Params: { id: string } }>("/repos/:id", async (request, reply) => {
    const access = await assertRepoAccess(request, db, request.params.id);
    if (!access.ok) return reply.status(access.status).send({ error: { code: access.status === 403 ? "forbidden" : "not_found", message: "Repo not found" } });
    const [project] = await db.select().from(repos).where(eq(repos.id, request.params.id));
    if (!project) return reply.status(404).send({ error: { code: "not_found", message: "Repo not found" } });
    return { data: project };
  });

  const updateSchema = z.object({
    name:            z.string().min(1).optional(),
    description:     z.string().nullable().optional(),
    repoUrl:         repoUrlSchema.nullable().optional(),
    defaultAssignee: z.string().nullable().optional(),
    context:         z.string().nullable().optional(),
  });

  fastify.put<{ Params: { id: string } }>("/repos/:id", async (request, reply) => {
    const body = updateSchema.safeParse(request.body);
    if (!body.success) return reply.status(400).send({ error: { code: "validation_error", message: body.error.message } });

    const access = await assertRepoAccess(request, db, request.params.id);
    if (!access.ok) return reply.status(access.status).send({ error: { code: access.status === 403 ? "forbidden" : "not_found", message: "Repo not found" } });

    if ("repoUrl" in body.data && request.agent && request.agent.role !== "orchestrator") {
      return reply.status(403).send({
        error: { code: "forbidden", message: "Only orchestrator agents may change repoUrl." },
      });
    }

    const [project] = await db
      .update(repos)
      .set(body.data)
      .where(eq(repos.id, request.params.id))
      .returning();

    if (!project) return reply.status(404).send({ error: { code: "not_found", message: "Repo not found" } });
    return { data: project };
  });

  fastify.delete<{ Params: { id: string } }>("/repos/:id", async (request, reply) => {
    const { id } = request.params;
    const access = await assertRepoAccess(request, db, id);
    if (!access.ok) return reply.status(access.status).send({ error: { code: access.status === 403 ? "forbidden" : "not_found", message: "Repo not found" } });
    const [project] = await db.select().from(repos).where(eq(repos.id, id));
    if (!project) return reply.status(404).send({ error: { code: "not_found", message: "Repo not found" } });

    // Cascade manually in dependency order
    const threadIds = (await db.select({ id: threads.id }).from(threads).where(eq(threads.repoId, id))).map((t) => t.id);
    if (threadIds.length > 0) await db.delete(messages).where(inArray(messages.threadId, threadIds));
    await db.delete(threads).where(eq(threads.repoId, id));

    const taskIds = (await db.select({ id: tasks.id }).from(tasks).where(eq(tasks.repoId, id))).map((t) => t.id);
    if (taskIds.length > 0) {
      await db.delete(routingLog).where(inArray(routingLog.taskId, taskIds));
      await db.delete(verificationLog).where(inArray(verificationLog.taskId, taskIds));
    }
    await db.delete(tasks).where(eq(tasks.repoId, id));

    // invites.createdBy → agents.id has no FK cascade, so invites must be cleared
    // before agents to avoid blocking the agent delete.
    await db.delete(invites).where(eq(invites.repoId, id));
    await db.delete(agents).where(eq(agents.repoId, id));
    await db.delete(repos).where(eq(repos.id, id));

    return reply.status(204).send();
  });
};
