import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { and, desc, eq, max } from "drizzle-orm";
import { artifacts, artifactVersions, artifactReads } from "@getrelai/db";
import type { Db } from "@getrelai/db";
import { newId } from "../lib/id.js";
import { publish, ensureSubscription } from "../lib/events.js";
import { assertRepoAccess } from "../lib/ownership.js";

// Well under BODY_LIMIT_BYTES, leaving room for the surrounding JSON. Artifacts
// are documents an agent writes, not file uploads; blob storage is out of scope.
export const ARTIFACT_BODY_MAX = 256 * 1024;

const publishSchema = z.object({
  repoId:      z.string(),
  name:        z.string().min(1).max(200),
  body:        z.string().min(1).max(ARTIFACT_BODY_MAX),
  description: z.string().optional(),
  contentType: z.string().min(1).optional(),
  visibility:  z.enum(["repo", "private"]).optional(),
  taskId:      z.string().optional(),
  metadata:    z.record(z.unknown()).optional(),
});

export const artifactRoutes: FastifyPluginAsync<{ db: Db }> = async (fastify, { db }) => {
  // Create-or-append. Publishing is deliberately one call with no ceremony: the
  // design principle is cheap to publish, strongly identified to consume, and
  // raising the cost here just means fewer, later, larger updates.
  fastify.post("/artifacts", async (request, reply) => {
    const body = publishSchema.safeParse(request.body);
    if (!body.success) return reply.status(400).send({ error: { code: "validation_error", message: body.error.message } });

    const access = await assertRepoAccess(request, db, body.data.repoId);
    if (!access.ok) {
      return reply.status(access.status).send({ error: { code: access.status === 403 ? "forbidden" : "not_found", message: "Repo not found" } });
    }

    const [existing] = await db.select().from(artifacts).where(and(
      eq(artifacts.repoId, body.data.repoId),
      eq(artifacts.name,   body.data.name),
    ));

    // Only the owner may publish a further version, so a colleague cannot
    // overwrite someone's artifact by guessing its name. The admin/owner path
    // has no agent identity and is allowed through.
    if (existing && request.agent && existing.ownerAgentId && existing.ownerAgentId !== request.agent.id) {
      return reply.status(403).send({
        error: { code: "forbidden", message: "Only the artifact's owner may publish a new version" },
      });
    }

    const artifact = existing ?? (await db.insert(artifacts).values({
      id:           newId("art"),
      repoId:       body.data.repoId,
      ownerAgentId: request.agent?.id ?? null,
      name:         body.data.name,
      description:  body.data.description ?? null,
      visibility:   body.data.visibility ?? "repo",
    }).returning())[0];

    const [{ value: currentMax }] = await db
      .select({ value: max(artifactVersions.version) })
      .from(artifactVersions)
      .where(eq(artifactVersions.artifactId, artifact.id));
    const nextVersion = (currentMax ?? 0) + 1;

    const [version] = await db.insert(artifactVersions).values({
      id:                 newId("av"),
      artifactId:         artifact.id,
      version:            nextVersion,
      body:               body.data.body,
      contentType:        body.data.contentType ?? "text/markdown",
      publishedByAgentId: request.agent?.id ?? null,
      taskId:             body.data.taskId ?? null,
      metadata:           body.data.metadata ?? {},
    }).returning();

    await publish(db, {
      id:         newId("evt"),
      kind:       "artifact.published",
      repoId:     artifact.repoId,
      targetType: "task",   // subscriptions only address thread|task|agent
      targetId:   artifact.id,
      alsoNotify: [],
      actorId:    request.agent?.id,
      payload:    { artifact: { id: artifact.id, name: artifact.name }, version: version.version },
      createdAt:  version.createdAt.toISOString(),
    });

    return reply.status(201).send({ data: { artifact, version } });
  });

  fastify.get<{ Querystring: { repoId?: string } }>("/artifacts", async (request, reply) => {
    const { repoId } = request.query;
    if (!repoId) return reply.status(400).send({ error: { code: "validation_error", message: "repoId required" } });

    const access = await assertRepoAccess(request, db, repoId);
    if (!access.ok) {
      return reply.status(access.status).send({ error: { code: access.status === 403 ? "forbidden" : "not_found", message: "Repo not found" } });
    }

    const rows = await db.select().from(artifacts).where(eq(artifacts.repoId, repoId));
    const visible = rows.filter(
      (a) => a.visibility === "repo" || !request.agent || a.ownerAgentId === request.agent.id,
    );

    const withCurrent = await Promise.all(visible.map(async (a) => {
      const [{ value }] = await db
        .select({ value: max(artifactVersions.version) })
        .from(artifactVersions)
        .where(eq(artifactVersions.artifactId, a.id));
      return { ...a, currentVersion: value ?? 0 };
    }));

    return { data: withCurrent };
  });

  // Reading records what version this agent has seen. That record, not a stream
  // of events, is what makes staleness answerable later without the publisher
  // having to tell anyone.
  fastify.get<{ Params: { name: string }; Querystring: { repoId?: string; version?: string } }>(
    "/artifacts/:name",
    async (request, reply) => {
      const { repoId, version: wanted } = request.query;
      if (!repoId) return reply.status(400).send({ error: { code: "validation_error", message: "repoId required" } });

      const access = await assertRepoAccess(request, db, repoId);
      if (!access.ok) {
        return reply.status(access.status).send({ error: { code: access.status === 403 ? "forbidden" : "not_found", message: "Repo not found" } });
      }

      const [artifact] = await db.select().from(artifacts).where(and(
        eq(artifacts.repoId, repoId),
        eq(artifacts.name,   decodeURIComponent(request.params.name)),
      ));
      if (!artifact) return reply.status(404).send({ error: { code: "not_found", message: "Artifact not found" } });
      if (artifact.visibility === "private" && request.agent && artifact.ownerAgentId !== request.agent.id) {
        return reply.status(404).send({ error: { code: "not_found", message: "Artifact not found" } });
      }

      const rows = wanted
        ? await db.select().from(artifactVersions).where(and(
            eq(artifactVersions.artifactId, artifact.id),
            eq(artifactVersions.version, Number(wanted)),
          ))
        : await db.select().from(artifactVersions)
            .where(eq(artifactVersions.artifactId, artifact.id))
            .orderBy(desc(artifactVersions.version)).limit(1);

      const [version] = rows;
      if (!version) return reply.status(404).send({ error: { code: "not_found", message: "Version not found" } });

      if (request.agent) {
        await db.insert(artifactReads).values({
          id:         newId("ard"),
          artifactId: artifact.id,
          agentId:    request.agent.id,
          version:    version.version,
          readAt:     new Date(),
        }).onConflictDoUpdate({
          target: [artifactReads.artifactId, artifactReads.agentId],
          set:    { version: version.version, readAt: new Date() },
        });
        await ensureSubscription(db, request.agent.id, "task", artifact.id);
      }

      return { data: { artifact, version } };
    },
  );

  fastify.get<{ Params: { name: string }; Querystring: { repoId?: string } }>(
    "/artifacts/:name/versions",
    async (request, reply) => {
      const { repoId } = request.query;
      if (!repoId) return reply.status(400).send({ error: { code: "validation_error", message: "repoId required" } });

      const access = await assertRepoAccess(request, db, repoId);
      if (!access.ok) {
        return reply.status(access.status).send({ error: { code: access.status === 403 ? "forbidden" : "not_found", message: "Repo not found" } });
      }

      const [artifact] = await db.select().from(artifacts).where(and(
        eq(artifacts.repoId, repoId),
        eq(artifacts.name,   decodeURIComponent(request.params.name)),
      ));
      if (!artifact) return reply.status(404).send({ error: { code: "not_found", message: "Artifact not found" } });

      // Bodies omitted: a version list is for choosing one, not for reading them all.
      const rows = await db
        .select({
          id: artifactVersions.id, version: artifactVersions.version,
          contentType: artifactVersions.contentType, publishedByAgentId: artifactVersions.publishedByAgentId,
          taskId: artifactVersions.taskId, createdAt: artifactVersions.createdAt,
        })
        .from(artifactVersions)
        .where(eq(artifactVersions.artifactId, artifact.id))
        .orderBy(desc(artifactVersions.version));

      return { data: rows };
    },
  );
};
