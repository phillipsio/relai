import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { buildServer } from "../server.js";
import { ARTIFACT_BODY_MAX } from "./artifacts.js";
import { createDb, artifacts, artifactVersions } from "@getrelai/db";
import { and, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";

const DB_URL = process.env.DATABASE_URL ?? "postgresql://relai:relai@localhost:5433/relai";
const SECRET = "test-secret-artifacts";

process.env.DATABASE_URL = DB_URL;
process.env.API_SECRET = SECRET;

const ADMIN = { Authorization: `Bearer ${SECRET}`, "Content-Type": "application/json" };
const asAgent = (t: string) => ({ Authorization: `Bearer ${t}`, "Content-Type": "application/json" });

let app: FastifyInstance;
let repoId: string;
let publisherToken: string, publisherId: string;
let consumerToken: string, consumerId: string;

beforeAll(async () => {
  app = buildServer({ logger: false, scheduler: false });
  await app.ready();

  const repo = await app.inject({
    method: "POST", url: "/repos", headers: ADMIN, body: JSON.stringify({ name: "__test__ artifacts" }),
  });
  repoId = repo.json().data.id;

  for (const name of ["publisher", "consumer"] as const) {
    const a = await app.inject({
      method: "POST", url: "/agents", headers: ADMIN,
      body: JSON.stringify({ repoId, name: `artifact-${name}`, role: "worker" }),
    });
    if (name === "publisher") { publisherToken = a.json().token; publisherId = a.json().data.id; }
    else { consumerToken = a.json().token; consumerId = a.json().data.id; }
  }
});

afterAll(async () => {
  if (repoId) await app.inject({ method: "DELETE", url: `/repos/${repoId}`, headers: ADMIN });
  await app?.close();
});

const publish = (token: string, body: Record<string, unknown>) =>
  app.inject({ method: "POST", url: "/artifacts", headers: asAgent(token), body: JSON.stringify({ repoId, ...body }) });

const pull = (token: string, name: string, query = "") =>
  app.inject({ method: "GET", url: `/artifacts/${encodeURIComponent(name)}?repoId=${repoId}${query}`, headers: asAgent(token) });

const sessionStart = (token: string) =>
  app.inject({ method: "GET", url: `/session/start?repoId=${repoId}`, headers: asAgent(token) });

describe("publishing is one call and versions itself", () => {
  it("creates on first publish and appends after that", async () => {
    const first = await publish(publisherToken, { name: "instructions", body: "v1 text" });
    expect(first.statusCode).toBe(201);
    expect(first.json().data.version.version).toBe(1);

    const second = await publish(publisherToken, { name: "instructions", body: "v2 text" });
    expect(second.json().data.version.version).toBe(2);
    expect(second.json().data.artifact.id).toBe(first.json().data.artifact.id);
  });

  it("serves the current version without being told which", async () => {
    const res = await pull(consumerToken, "instructions");

    expect(res.statusCode).toBe(200);
    expect(res.json().data.version.version).toBe(2);
    expect(res.json().data.version.body).toBe("v2 text");
  });

  it("can still serve an earlier version on request", async () => {
    const res = await pull(consumerToken, "instructions", "&version=1");
    expect(res.json().data.version.body).toBe("v1 text");
  });

  it("lists versions without their bodies", async () => {
    const res = await app.inject({
      method: "GET", url: `/artifacts/instructions/versions?repoId=${repoId}`, headers: asAgent(consumerToken),
    });

    expect(res.json().data).toHaveLength(2);
    expect(res.json().data[0].version).toBe(2);
    expect(res.json().data[0]).not.toHaveProperty("body");
  });

  it("refuses a body past the artifact cap", async () => {
    const res = await publish(publisherToken, { name: "too-big", body: "x".repeat(ARTIFACT_BODY_MAX + 1) });
    expect(res.statusCode).toBe(400);
  });

  it("refuses a colleague publishing over someone else's artifact", async () => {
    const res = await publish(consumerToken, { name: "instructions", body: "hijacked" });

    expect(res.statusCode).toBe(403);
    const db = createDb(DB_URL);
    const [art] = await db.select().from(artifacts).where(and(eq(artifacts.repoId, repoId), eq(artifacts.name, "instructions")));
    const rows = await db.select().from(artifactVersions).where(eq(artifactVersions.artifactId, art.id));
    expect(rows).toHaveLength(2);
  });

  it("hides a private artifact from everyone but its owner", async () => {
    await publish(publisherToken, { name: "draft", body: "wip", visibility: "private" });

    expect((await pull(consumerToken, "draft")).statusCode).toBe(404);
    expect((await pull(publisherToken, "draft")).statusCode).toBe(200);

    const list = await app.inject({ method: "GET", url: `/artifacts?repoId=${repoId}`, headers: asAgent(consumerToken) });
    expect(list.json().data.map((a: { name: string }) => a.name)).not.toContain("draft");
  });
});

describe("the consumer learns a pull went stale without being told", () => {
  // This is Stage C's actual point. The failure it replaces is a human noticing
  // a newer paste in a chat scrollback and remembering to re-apply it.
  it("reports nothing stale right after a pull", async () => {
    await publish(publisherToken, { name: "surface", body: "v1" });
    await pull(consumerToken, "surface");

    const res = await sessionStart(consumerToken);
    const stale = res.json().data.staleArtifacts as Array<{ name: string }>;
    expect(stale.map((s) => s.name)).not.toContain("surface");
  });

  it("reports the artifact stale once a newer version lands", async () => {
    await publish(publisherToken, { name: "surface", body: "v2" });

    const res = await sessionStart(consumerToken);
    const stale = res.json().data.staleArtifacts as Array<{ name: string; readVersion: number; currentVersion: number }>;
    const entry = stale.find((s) => s.name === "surface");

    expect(entry).toBeDefined();
    expect(entry!.readVersion).toBe(1);
    expect(entry!.currentVersion).toBe(2);
  });

  // Five versions in two hours is a real pattern, and the reason staleness is
  // state rather than a stream: it collapses to one entry, not five nudges.
  it("collapses a burst of publishes into a single stale entry", async () => {
    for (const v of ["v3", "v4", "v5"]) await publish(publisherToken, { name: "surface", body: v });

    const res = await sessionStart(consumerToken);
    const stale = (res.json().data.staleArtifacts as Array<{ name: string; currentVersion: number }>)
      .filter((s) => s.name === "surface");

    expect(stale).toHaveLength(1);
    expect(stale[0].currentVersion).toBe(5);
  });

  it("clears once the consumer re-pulls", async () => {
    await pull(consumerToken, "surface");

    const res = await sessionStart(consumerToken);
    const stale = res.json().data.staleArtifacts as Array<{ name: string }>;
    expect(stale.map((s) => s.name)).not.toContain("surface");
  });

  // Found by dogfooding through the MCP tools: an explicit older-version pull
  // moved the read pointer backwards and reported the agent stale on something
  // it had already read.
  it("does not go stale after deliberately reading an older version", async () => {
    await publish(publisherToken, { name: "backref", body: "v1" });
    await publish(publisherToken, { name: "backref", body: "v2" });

    await pull(consumerToken, "backref");             // current: v2
    await pull(consumerToken, "backref", "&version=1");  // historical lookup

    const res = await sessionStart(consumerToken);
    const stale = res.json().data.staleArtifacts as Array<{ name: string }>;
    expect(stale.map((s) => s.name)).not.toContain("backref");
  });

  it("does not report staleness to an agent that never pulled it", async () => {
    await publish(publisherToken, { name: "unread-by-consumer", body: "v1" });
    await publish(publisherToken, { name: "unread-by-consumer", body: "v2" });

    const res = await sessionStart(consumerToken);
    const stale = res.json().data.staleArtifacts as Array<{ name: string }>;
    expect(stale.map((s) => s.name)).not.toContain("unread-by-consumer");
  });
});
