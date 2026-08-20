import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { buildServer } from "../server.js";
import type { FastifyInstance } from "fastify";

const DB_URL = process.env.DATABASE_URL ?? "postgresql://relai:relai@localhost:5433/relai";
const SECRET = "test-secret-feedback-author";

process.env.DATABASE_URL = DB_URL;
process.env.API_SECRET = SECRET;

const ADMIN = { Authorization: `Bearer ${SECRET}`, "Content-Type": "application/json" };
const asAgent = (t: string) => ({ Authorization: `Bearer ${t}`, "Content-Type": "application/json" });

let app: FastifyInstance;
let homeRepo: string, triageRepo: string;
let reporter: string, reporterToken: string;
let colleagueToken: string;
let filedTaskId: string;

beforeAll(async () => {
  app = buildServer({ logger: false, scheduler: false });
  await app.ready();

  const mkRepo = async (name: string) => {
    const r = await app.inject({ method: "POST", url: "/repos", headers: ADMIN, body: JSON.stringify({ name }) });
    return r.json().data.id as string;
  };
  homeRepo = await mkRepo("__test__ fb home");
  triageRepo = await mkRepo("__test__ fb triage");

  const mkAgent = async (repoId: string, name: string) => {
    const a = await app.inject({
      method: "POST", url: "/agents", headers: ADMIN, body: JSON.stringify({ repoId, name, role: "worker" }),
    });
    return { id: a.json().data.id as string, token: a.json().token as string };
  };
  ({ id: reporter, token: reporterToken } = await mkAgent(homeRepo, "fb-reporter"));
  ({ token: colleagueToken } = await mkAgent(homeRepo, "fb-colleague"));

  // Stands in for what POST /relai-feedback does: a task in the triage repo
  // whose createdBy is an agent belonging to a different repo.
  const t = await app.inject({
    method: "POST", url: "/tasks", headers: ADMIN,
    body: JSON.stringify({
      repoId: triageRepo, createdBy: reporter, title: "Feedback from elsewhere",
      description: "something is broken", domains: ["feedback"],
    }),
  });
  filedTaskId = t.json().data.id;
});

afterAll(async () => {
  for (const r of [homeRepo, triageRepo]) {
    if (r) await app.inject({ method: "DELETE", url: `/repos/${r}`, headers: ADMIN });
  }
  await app?.close();
});

describe("filing a report is not write-only", () => {
  it("lets the reporter read the task it filed in another repo", async () => {
    const res = await app.inject({
      method: "GET", url: `/tasks/${filedTaskId}`, headers: asAgent(reporterToken),
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().data.title).toBe("Feedback from elsewhere");
  });

  it("lets the reporter read and add comments, so a mangled report can be corrected", async () => {
    const post = await app.inject({
      method: "POST", url: `/tasks/${filedTaskId}/comments`, headers: asAgent(reporterToken),
      body: JSON.stringify({ body: "correction: the title lost its formatting" }),
    });
    expect(post.statusCode).toBe(201);

    const get = await app.inject({
      method: "GET", url: `/tasks/${filedTaskId}/comments`, headers: asAgent(reporterToken),
    });
    expect(get.statusCode).toBe(200);
    expect(get.json().data.comments.map((c: { body: string }) => c.body))
      .toContain("correction: the title lost its formatting");
  });
});

describe("the exception is read-and-comment only", () => {
  it("does not let the reporter change the task it filed", async () => {
    const res = await app.inject({
      method: "PUT", url: `/tasks/${filedTaskId}`, headers: asAgent(reporterToken),
      body: JSON.stringify({ status: "completed", priority: "urgent" }),
    });

    expect(res.statusCode).toBe(404);
  });

  it("does not let the reporter archive it", async () => {
    const res = await app.inject({
      method: "PUT", url: `/tasks/${filedTaskId}/archive`, headers: asAgent(reporterToken),
      body: JSON.stringify({}),
    });

    expect(res.statusCode).toBe(404);
  });

  it("does not let the reporter commit it", async () => {
    const res = await app.inject({
      method: "POST", url: `/tasks/${filedTaskId}/commit`, headers: asAgent(reporterToken),
      body: JSON.stringify({ decision: "commit" }),
    });

    expect(res.statusCode).toBe(404);
  });

  // Authorship is the whole basis for the exception, so a colleague in the
  // reporter's own repo must get nothing from it.
  it("gives nothing to another agent that did not file it", async () => {
    const read = await app.inject({
      method: "GET", url: `/tasks/${filedTaskId}`, headers: asAgent(colleagueToken),
    });
    expect(read.statusCode).toBe(404);

    const comment = await app.inject({
      method: "POST", url: `/tasks/${filedTaskId}/comments`, headers: asAgent(colleagueToken),
      body: JSON.stringify({ body: "me too" }),
    });
    expect(comment.statusCode).toBe(404);
  });

  it("still refuses a foreign task the agent did not create", async () => {
    const other = await app.inject({
      method: "POST", url: "/tasks", headers: ADMIN,
      body: JSON.stringify({ repoId: triageRepo, createdBy: "human", title: "internal", description: "x" }),
    });

    const res = await app.inject({
      method: "GET", url: `/tasks/${other.json().data.id}`, headers: asAgent(reporterToken),
    });
    expect(res.statusCode).toBe(404);
  });
});
