import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { eq, and, inArray } from "drizzle-orm";
import { agents, tokens, repos, tasks, routingLog, invites, artifacts, artifactVersions } from "@getrelai/db";
import { newId } from "../lib/id.js";
import { generateToken, hashToken } from "../lib/tokens.js";
import { assertRepoAccess, assertAgentAccess, callerMayActOnAgent } from "../lib/ownership.js";
import type { Db } from "@getrelai/db";

const registerSchema = z.object({
  repoId:      z.string(),
  name:           z.string().min(1),
  role:           z.enum(["orchestrator", "worker"]),
  specialization: z.string().optional(),
  tier:           z.number().int().min(1).max(2).optional(),
  domains:        z.array(z.string()).default([]),
  workerType:     z.enum(["claude", "copilot", "cursor", "windsurf", "gemini", "gpt", "mcp", "human"]).optional(),
  repoPath:       z.string().optional(),
});

export const agentRoutes: FastifyPluginAsync<{ db: Db }> = async (fastify, { db }) => {
  fastify.post("/agents", async (request, reply) => {
    const body = registerSchema.safeParse(request.body);
    if (!body.success) return reply.status(400).send({ error: { code: "validation_error", message: body.error.message } });

    const access = await assertRepoAccess(request, db, body.data.repoId);
    if (!access.ok) return reply.status(access.status).send({ error: { code: access.status === 403 ? "forbidden" : "not_found", message: "Repo not found" } });

    // Registering an agent mints a credential and names its own role, so it is
    // an orchestrator/owner act. Without this a worker could hand itself an
    // orchestrator token, which reaches shell verify predicates and therefore
    // command execution in this process.
    if (request.agent && request.agent.role !== "orchestrator") {
      return reply.status(403).send({
        error: { code: "forbidden", message: "Only orchestrator agents may register agents." },
      });
    }

    const [agent] = await db.insert(agents).values({
      id:             newId("agent"),
      repoId:      body.data.repoId,
      name:           body.data.name,
      role:           body.data.role,
      specialization: body.data.specialization ?? null,
      tier:           body.data.tier ?? null,
      domains:        body.data.domains,
      workerType:     body.data.workerType ?? null,
      repoPath:       body.data.repoPath ?? null,
      lastSeenAt:     new Date(0), // never connected; first heartbeat marks it online
    }).returning();

    const plaintext = generateToken();
    await db.insert(tokens).values({
      id:        newId("tok"),
      agentId:   agent.id,
      tokenHash: hashToken(plaintext),
    });

    return reply.status(201).send({ data: agent, token: plaintext });
  });

  fastify.post<{ Params: { id: string } }>("/agents/:id/tokens", async (request, reply) => {
    const check = await assertAgentAccess(request, db, request.params.id);
    if (!check.ok) return reply.status(check.status).send({ error: { code: "not_found", message: "Agent not found" } });
    const agent = check.agent;

    // Repo membership alone let any worker mint another agent's token; see
    // callerMayActOnAgent.
    if (!callerMayActOnAgent(request, agent.id)) {
      return reply.status(403).send({
        error: { code: "forbidden", message: "Only the agent itself or an orchestrator may rotate this token." },
      });
    }

    const plaintext = generateToken();
    const [row] = await db.insert(tokens).values({
      id:        newId("tok"),
      agentId:   agent.id,
      tokenHash: hashToken(plaintext),
    }).returning();

    return reply.status(201).send({ data: row, token: plaintext });
  });

  fastify.put<{ Params: { id: string } }>("/agents/:id/heartbeat", async (request, reply) => {
    const check = await assertAgentAccess(request, db, request.params.id);
    if (!check.ok) return reply.status(check.status).send({ error: { code: "not_found", message: "Agent not found" } });
    // Rules routing keeps agents seen in the last 10 minutes, so a forged stamp
    // holds an offline peer in the pool and its tasks are never collected.
    if (!callerMayActOnAgent(request, request.params.id)) {
      return reply.status(403).send({ error: { code: "forbidden", message: "Cannot heartbeat another agent" } });
    }

    const [agent] = await db
      .update(agents)
      .set({ lastSeenAt: new Date() })
      .where(eq(agents.id, request.params.id))
      .returning();

    return { data: agent };
  });

  fastify.get<{ Params: { id: string } }>("/agents/:id", async (request, reply) => {
    const check = await assertAgentAccess(request, db, request.params.id);
    if (!check.ok) return reply.status(check.status).send({ error: { code: "not_found", message: "Agent not found" } });
    return { data: check.agent };
  });

  fastify.delete<{ Params: { id: string } }>("/agents/:id", async (request, reply) => {
    const check = await assertAgentAccess(request, db, request.params.id);
    if (!check.ok) return reply.status(check.status).send({ error: { code: "not_found", message: "Agent not found" } });

    if (!callerMayActOnAgent(request, check.agent.id)) {
      return reply.status(403).send({
        error: { code: "forbidden", message: "Only the agent itself or an orchestrator may delete this agent." },
      });
    }

    const agentId = request.params.id;

    // One transaction, so a scheduler tick that reassigns mid-cascade rolls the
    // whole thing back. Agent-last because these FKs are not DEFERRABLE.
    await db.transaction(async (tx) => {
      // An assigned task with a null assignee is unreachable, so anything still
      // in flight goes back to the queue rather than being stranded.
      await tx.update(tasks)
        .set({ status: "pending", assignedTo: null, autoAssign: true })
        .where(and(
          eq(tasks.assignedTo, agentId),
          inArray(tasks.status, ["assigned", "in_progress", "blocked", "pending_verification"]),
        ));
      await tx.update(tasks).set({ assignedTo: null }).where(eq(tasks.assignedTo, agentId));

      // routing_log.assigned_to is NOT NULL, so the decision rows go with the
      // agent. They record who was chosen, meaningless once it is gone.
      await tx.delete(routingLog).where(eq(routingLog.assignedTo, agentId));

      await tx.update(invites).set({ createdBy: null }).where(eq(invites.createdBy, agentId));
      await tx.update(invites).set({ acceptedAgentId: null }).where(eq(invites.acceptedAgentId, agentId));
      await tx.update(artifacts).set({ ownerAgentId: null }).where(eq(artifacts.ownerAgentId, agentId));
      await tx.update(artifactVersions).set({ publishedByAgentId: null }).where(eq(artifactVersions.publishedByAgentId, agentId));

      // No FK on either, so they raise nothing now and break later: a dangling
      // defaultAssignee fails every later insert in this repo.
      await tx.update(repos).set({ defaultAssignee: null }).where(eq(repos.defaultAssignee, agentId));
      await tx.update(tasks).set({ verifyReviewerId: null }).where(eq(tasks.verifyReviewerId, agentId));

      await tx.delete(agents).where(eq(agents.id, agentId));
    });

    return reply.status(204).send();
  });

  fastify.get<{ Querystring: { repoId?: string } }>("/agents", async (request, reply) => {
    const { repoId } = request.query;

    // Per-agent caller: the agents of every repo sharing this one's owner, so a
    // peer in a sibling repo can at least be found. This is the read-shaped
    // subset of cross-repo access — it discloses that an agent exists and
    // whether it is awake, and grants nothing else: tasks, threads, messages and
    // event delivery all stay repo-bound.
    //
    // Falls back to own-repo when the owner is null, which is the self-hosted
    // default. Without that, "same owner" would match every unowned repo on the
    // instance and turn a directory into a disclosure.
    if (request.agent) {
      const [ownRepo] = await db
        .select({ ownerId: repos.ownerId })
        .from(repos)
        .where(eq(repos.id, request.agent.repoId));

      if (!ownRepo?.ownerId) {
        const rows = await db.select().from(agents).where(eq(agents.repoId, request.agent.repoId));
        return { data: rows };
      }

      const siblingIds = (await db
        .select({ id: repos.id })
        .from(repos)
        .where(eq(repos.ownerId, ownRepo.ownerId))).map((r) => r.id);
      const rows = await db.select().from(agents).where(inArray(agents.repoId, siblingIds));
      return { data: rows };
    }

    // Service-admin: filter to repos owned by this tenant.
    if (request.ownerId) {
      const ownedRepoIds = (await db
        .select({ id: repos.id })
        .from(repos)
        .where(eq(repos.ownerId, request.ownerId))).map((p) => p.id);
      if (ownedRepoIds.length === 0) return { data: [] };
      const where = repoId
        ? and(inArray(agents.repoId, ownedRepoIds), eq(agents.repoId, repoId))!
        : inArray(agents.repoId, ownedRepoIds);
      const rows = await db.select().from(agents).where(where);
      return { data: rows };
    }

    // Legacy API_SECRET: full visibility.
    const rows = repoId
      ? await db.select().from(agents).where(eq(agents.repoId, repoId))
      : await db.select().from(agents);
    return { data: rows };
  });
};
