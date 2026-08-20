import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { buildServer } from "../server.js";
import { watchBlockedTasks } from "../lib/router/scheduler.js";
import { createDb, tasks, users } from "@getrelai/db";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";

const DB_URL = process.env.DATABASE_URL ?? "postgresql://relai:relai@localhost:5433/relai";
const SECRET = "test-secret-agent-answer";
const SERVICE_TOKEN = "test-service-agent-answer";
const ownerId = "usr_agent_answer_owner";

process.env.DATABASE_URL = DB_URL;
process.env.API_SECRET = SECRET;
process.env.SERVICE_ADMIN_TOKEN = SERVICE_TOKEN;

const ADMIN = { Authorization: `Bearer ${SECRET}`, "Content-Type": "application/json" };
const OWNER = { Authorization: `Bearer ${SERVICE_TOKEN}`, "X-Owner-Id": ownerId, "Content-Type": "application/json" };
const asAgent = (t: string) => ({ Authorization: `Bearer ${t}`, "Content-Type": "application/json" });

let app: FastifyInstance;
let repoId: string;
let asker: string, askerToken: string;
let expert: string, expertToken: string;
let bystander: string, bystanderToken: string;

beforeAll(async () => {
  app = buildServer({ logger: false, scheduler: false });
  await app.ready();

  const db = createDb(DB_URL);
  await db.insert(users).values({ id: ownerId, email: `${ownerId}@test.local` }).onConflictDoNothing();

  const repo = await app.inject({
    method: "POST", url: "/repos", headers: OWNER, body: JSON.stringify({ name: "__test__ agent answer" }),
  });
  repoId = repo.json().data.id;

  const mk = async (name: string) => {
    const a = await app.inject({
      method: "POST", url: "/agents", headers: ADMIN,
      body: JSON.stringify({ repoId, name, role: "worker" }),
    });
    return { id: a.json().data.id as string, token: a.json().token as string };
  };
  ({ id: asker, token: askerToken } = await mk("answer-asker"));
  ({ id: expert, token: expertToken } = await mk("answer-expert"));
  ({ id: bystander, token: bystanderToken } = await mk("answer-bystander"));
});

afterAll(async () => {
  if (repoId) await app.inject({ method: "DELETE", url: `/repos/${repoId}`, headers: ADMIN });
  await app?.close();
});

async function askedAndBlocked(opts: { toAgent?: string } = {}) {
  const th = await app.inject({
    method: "POST", url: "/threads", headers: ADMIN, body: JSON.stringify({ repoId, title: "question thread" }),
  });
  const threadId = th.json().data.id as string;

  const task = await app.inject({
    method: "POST", url: "/tasks", headers: ADMIN,
    body: JSON.stringify({ repoId, createdBy: asker, title: "needs an answer", description: "x", assignedTo: asker }),
  });
  const taskId = task.json().data.id as string;

  // The asker poses the question itself, so fromAgent is derived from its token.
  await app.inject({
    method: "POST", url: `/threads/${threadId}/messages`, headers: asAgent(askerToken),
    body: JSON.stringify({ type: "question", body: "which step is riskiest?", ...(opts.toAgent ? { toAgent: opts.toAgent } : {}) }),
  });

  await app.inject({
    method: "PUT", url: `/tasks/${taskId}`, headers: asAgent(askerToken),
    body: JSON.stringify({ status: "blocked", metadata: { blockedThreadId: threadId } }),
  });

  return { taskId, threadId };
}

const reply = (token: string, threadId: string, body: string) =>
  app.inject({
    method: "POST", url: `/threads/${threadId}/messages`, headers: asAgent(token),
    body: JSON.stringify({ type: "reply", body }),
  });

const sweep = async () => {
  const db = createDb(DB_URL);
  await watchBlockedTasks(db, repoId);
};

const load = async (taskId: string) => {
  const db = createDb(DB_URL);
  const [row] = await db.select().from(tasks).where(eq(tasks.id, taskId));
  return row;
};

describe("a blocked task resumes when the agent it asked answers", () => {
  it("resumes on an answer from the addressed agent", async () => {
    const { taskId, threadId } = await askedAndBlocked({ toAgent: expert });

    await reply(expertToken, threadId, "step 1, migrations run against prod data");
    await sweep();

    const row = await load(taskId);
    expect(row.status).toBe("assigned");
    const meta = row.metadata as Record<string, unknown>;
    const answer = meta.agentReply as Record<string, unknown>;
    expect(answer.body).toBe("step 1, migrations run against prod data");
    expect(answer.fromAgent).toBe(expert);
  });

  // The narrowing that makes this safe: being an agent is not enough.
  it("ignores an answer from an agent that was not asked", async () => {
    const { taskId, threadId } = await askedAndBlocked({ toAgent: expert });

    await reply(bystanderToken, threadId, "I have opinions too");
    await sweep();

    expect((await load(taskId)).status).toBe("blocked");
  });

  // The self-resume attack: address the question to yourself, then answer it.
  it("refuses to let the asker answer its own question", async () => {
    const { taskId, threadId } = await askedAndBlocked({ toAgent: asker });

    await reply(askerToken, threadId, "I'll just unblock myself, thanks");
    await sweep();

    expect((await load(taskId)).status).toBe("blocked");
  });

  it("ignores agent replies when the question addressed nobody", async () => {
    const { taskId, threadId } = await askedAndBlocked();

    await reply(expertToken, threadId, "answering unprompted");
    await sweep();

    expect((await load(taskId)).status).toBe("blocked");
  });

  it("ignores an answer that predates the blocking", async () => {
    const th = await app.inject({
      method: "POST", url: "/threads", headers: ADMIN, body: JSON.stringify({ repoId, title: "early answer" }),
    });
    const threadId = th.json().data.id as string;
    const task = await app.inject({
      method: "POST", url: "/tasks", headers: ADMIN,
      body: JSON.stringify({ repoId, createdBy: asker, title: "t", description: "x", assignedTo: asker }),
    });
    const taskId = task.json().data.id as string;

    await app.inject({
      method: "POST", url: `/threads/${threadId}/messages`, headers: asAgent(askerToken),
      body: JSON.stringify({ type: "question", body: "q?", toAgent: expert }),
    });
    await reply(expertToken, threadId, "answered before the block");
    await app.inject({
      method: "PUT", url: `/tasks/${taskId}`, headers: asAgent(askerToken),
      body: JSON.stringify({ status: "blocked", metadata: { blockedThreadId: threadId } }),
    });

    await sweep();
    expect((await load(taskId)).status).toBe("blocked");
  });
});

describe("the human path is unchanged", () => {
  it("still resumes on a human reply, with humanReply set as before", async () => {
    const { taskId, threadId } = await askedAndBlocked({ toAgent: expert });

    await app.inject({
      method: "POST", url: `/threads/${threadId}/messages`, headers: OWNER,
      body: JSON.stringify({ type: "reply", body: "the human decides" }),
    });
    await sweep();

    const row = await load(taskId);
    expect(row.status).toBe("assigned");
    const meta = row.metadata as Record<string, unknown>;
    expect(meta.humanReply).toBe("the human decides");
    expect(meta.agentReply).toBeUndefined();
  });

  it("still resumes on a human reply even when nobody was addressed", async () => {
    const { taskId, threadId } = await askedAndBlocked();

    await app.inject({
      method: "POST", url: `/threads/${threadId}/messages`, headers: OWNER,
      body: JSON.stringify({ type: "reply", body: "unblocking you" }),
    });
    await sweep();

    expect((await load(taskId)).status).toBe("assigned");
  });

  // A human answer is the stronger signal, so it should win rather than race.
  it("prefers the human answer when both landed", async () => {
    const { taskId, threadId } = await askedAndBlocked({ toAgent: expert });

    await reply(expertToken, threadId, "the agent's take");
    await app.inject({
      method: "POST", url: `/threads/${threadId}/messages`, headers: OWNER,
      body: JSON.stringify({ type: "reply", body: "the human's call" }),
    });
    await sweep();

    const meta = (await load(taskId)).metadata as Record<string, unknown>;
    expect(meta.humanReply).toBe("the human's call");
  });
});
