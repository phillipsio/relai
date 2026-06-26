import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { buildServer } from "../../server.js";
import { verifyPending } from "./scheduler.js";
import { bus, type AppEvent } from "../events.js";
import { createDb, tasks, verificationLog, repos } from "@getrelai/db";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";

const DB_URL = process.env.DATABASE_URL ?? "postgresql://relai:relai@localhost:5433/relai";
const SECRET = "test-secret-verify";

process.env.DATABASE_URL = DB_URL;
process.env.API_SECRET   = SECRET;

const ADMIN = { Authorization: `Bearer ${SECRET}`, "Content-Type": "application/json" };

let app: FastifyInstance;
let repoId: string;
let agentId: string;

beforeAll(async () => {
  app = buildServer({ logger: false, scheduler: false });
  await app.ready();

  const project = await app.inject({
    method: "POST", url: "/repos", headers: ADMIN,
    body: JSON.stringify({ name: "__test__ verify" }),
  });
  repoId = project.json().data.id;

  const a = await app.inject({
    method: "POST", url: "/agents", headers: ADMIN,
    body: JSON.stringify({ repoId, name: "verify-agent", role: "worker" }),
  });
  agentId = a.json().data.id;
});

afterAll(async () => {
  if (repoId) {
    await app.inject({ method: "DELETE", url: `/repos/${repoId}`, headers: ADMIN });
  }
  await app?.close();
});

async function makePendingVerificationTask(verifyCommand: string, verifyTimeoutMs?: number): Promise<string> {
  const create = await app.inject({
    method: "POST", url: "/tasks", headers: ADMIN,
    body: JSON.stringify({
      repoId, createdBy: agentId, title: "verify-test", description: "x",
      assignedTo: agentId, verifyCommand,
      ...(verifyTimeoutMs !== undefined ? { verifyTimeoutMs } : {}),
    }),
  });
  const taskId = create.json().data.id;

  // Move directly into pending_verification via the gated PUT.
  await app.inject({
    method: "PUT", url: `/tasks/${taskId}`, headers: ADMIN,
    body: JSON.stringify({ status: "completed" }),
  });

  return taskId;
}

describe("verifyPending", () => {
  it("promotes to completed when the predicate passes", async () => {
    const taskId = await makePendingVerificationTask("noop-pass");
    const db = createDb(DB_URL);

    const events: AppEvent[] = [];
    const handler = (e: AppEvent) => events.push(e);
    bus.on("event", handler);

    await verifyPending(db, repoId, async () => ({
      exitCode: 0, stdout: "ok", stderr: "", durationMs: 12, timedOut: false,
    }));

    bus.off("event", handler);

    const [row] = await db.select().from(tasks).where(eq(tasks.id, taskId));
    expect(row.status).toBe("completed");
    expect(row.verifyingAt).toBeNull();

    const logs = await db.select().from(verificationLog).where(eq(verificationLog.taskId, taskId));
    expect(logs.length).toBe(1);
    expect(logs[0].exitCode).toBe(0);

    const verified = events.find((e) => e.kind === "task.verified" && e.targetId === taskId);
    expect(verified).toBeDefined();
  });

  it("returns the task to assigned and records lastVerification on failure", async () => {
    const taskId = await makePendingVerificationTask("noop-fail");
    const db = createDb(DB_URL);

    const events: AppEvent[] = [];
    const handler = (e: AppEvent) => events.push(e);
    bus.on("event", handler);

    await verifyPending(db, repoId, async () => ({
      exitCode: 2, stdout: "", stderr: "boom", durationMs: 7, timedOut: false,
    }));

    bus.off("event", handler);

    const [row] = await db.select().from(tasks).where(eq(tasks.id, taskId));
    expect(row.status).toBe("assigned");
    expect(row.verifyingAt).toBeNull();
    const meta = row.metadata as Record<string, unknown>;
    const last = meta.lastVerification as { exitCode: number; timedOut: boolean; logId: string };
    expect(last.exitCode).toBe(2);
    expect(last.timedOut).toBe(false);
    expect(last.logId).toMatch(/^verif_/);

    const failed = events.find((e) => e.kind === "task.verification_failed" && e.targetId === taskId);
    expect(failed).toBeDefined();
  });

  it("passes per-task verifyTimeoutMs through to the executor; falls back to default when null", async () => {
    const customTaskId  = await makePendingVerificationTask("noop-custom", 5_000);
    const defaultTaskId = await makePendingVerificationTask("noop-default");
    const db = createDb(DB_URL);

    const observed: Array<{ command: string; timeoutMs: number | undefined }> = [];
    await verifyPending(db, repoId, async (command, _cwd, timeoutMs) => {
      observed.push({ command, timeoutMs });
      return { exitCode: 0, stdout: "", stderr: "", durationMs: 1, timedOut: false };
    });

    const custom  = observed.find((o) => o.command === "noop-custom");
    const dflt    = observed.find((o) => o.command === "noop-default");
    expect(custom?.timeoutMs).toBe(5_000);
    expect(dflt?.timeoutMs).toBeUndefined();   // executor's own default applies

    // Sanity: both tasks completed.
    const [c] = await db.select().from(tasks).where(eq(tasks.id, customTaskId));
    const [d] = await db.select().from(tasks).where(eq(tasks.id, defaultTaskId));
    expect(c.status).toBe("completed");
    expect(d.status).toBe("completed");
  });

  it("dispatches kind=file_exists without invoking the shell exec; passes when the file exists", async () => {
    const dir = await mkdtemp(join(tmpdir(), "relai-fxv-sched-"));
    try {
      await writeFile(join(dir, "artifact.txt"), "ok");

      const create = await app.inject({
        method: "POST", url: "/tasks", headers: ADMIN,
        body: JSON.stringify({
          repoId, createdBy: agentId, title: "fx", description: "x",
          assignedTo: agentId,
          verifyKind: "file_exists",
          verifyPath: "artifact.txt",
          verifyCwd:  dir,
        }),
      });
      const taskId = create.json().data.id;
      await app.inject({
        method: "PUT", url: `/tasks/${taskId}`, headers: ADMIN,
        body: JSON.stringify({ status: "completed" }),
      });

      const db = createDb(DB_URL);
      let shellExecCalled = false;
      await verifyPending(db, repoId, async () => {
        shellExecCalled = true;
        return { exitCode: 0, stdout: "", stderr: "", durationMs: 0, timedOut: false };
      });

      expect(shellExecCalled).toBe(false);
      const [row] = await db.select().from(tasks).where(eq(tasks.id, taskId));
      expect(row.status).toBe("completed");
      const logs = await db.select().from(verificationLog).where(eq(verificationLog.taskId, taskId));
      expect(logs[0].command).toBe(`file_exists:artifact.txt`);
      expect(logs[0].exitCode).toBe(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("kind=file_exists fails verification when the file is missing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "relai-fxv-miss-"));
    try {
      const create = await app.inject({
        method: "POST", url: "/tasks", headers: ADMIN,
        body: JSON.stringify({
          repoId, createdBy: agentId, title: "fx-miss", description: "x",
          assignedTo: agentId,
          verifyKind: "file_exists",
          verifyPath: "ghost.txt",
          verifyCwd:  dir,
        }),
      });
      const taskId = create.json().data.id;
      await app.inject({
        method: "PUT", url: `/tasks/${taskId}`, headers: ADMIN,
        body: JSON.stringify({ status: "completed" }),
      });

      const db = createDb(DB_URL);
      await verifyPending(db, repoId);

      const [row] = await db.select().from(tasks).where(eq(tasks.id, taskId));
      expect(row.status).toBe("assigned");
      const meta = row.metadata as Record<string, unknown>;
      const last = meta.lastVerification as { exitCode: number };
      expect(last.exitCode).toBe(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("kind=git_pushed passes when the branch exists on origin", async () => {
    const git = promisify(execFile);
    const bareDir = await mkdtemp(join(tmpdir(), "relai-gpv-sched-bare-"));
    const workDir = await mkdtemp(join(tmpdir(), "relai-gpv-sched-work-"));
    try {
      await git("git", ["init", "--bare", "-q", bareDir]);
      await git("git", ["init", "-q", workDir]);
      await git("git", ["config", "user.email", "test@example.com"], { cwd: workDir });
      await git("git", ["config", "user.name", "Test"], { cwd: workDir });
      await git("git", ["remote", "add", "origin", bareDir], { cwd: workDir });
      await writeFile(join(workDir, "f.txt"), "x");
      await git("git", ["add", "."], { cwd: workDir });
      await git("git", ["commit", "-q", "-m", "init"], { cwd: workDir });
      await git("git", ["checkout", "-q", "-b", "landed"], { cwd: workDir });
      await git("git", ["push", "-q", "origin", "landed"], { cwd: workDir });

      const create = await app.inject({
        method: "POST", url: "/tasks", headers: ADMIN,
        body: JSON.stringify({
          repoId, createdBy: agentId, title: "gp", description: "x",
          assignedTo: agentId,
          verifyKind: "git_pushed",
          verifyPath: "landed",
          verifyCwd:  workDir,
        }),
      });
      const taskId = create.json().data.id;
      await app.inject({
        method: "PUT", url: `/tasks/${taskId}`, headers: ADMIN,
        body: JSON.stringify({ status: "completed" }),
      });

      const db = createDb(DB_URL);
      let shellExecCalled = false;
      await verifyPending(db, repoId, async () => {
        shellExecCalled = true;
        return { exitCode: 0, stdout: "", stderr: "", durationMs: 0, timedOut: false };
      });

      expect(shellExecCalled).toBe(false);
      const [row] = await db.select().from(tasks).where(eq(tasks.id, taskId));
      expect(row.status).toBe("completed");
      const logs = await db.select().from(verificationLog).where(eq(verificationLog.taskId, taskId));
      expect(logs[0].command).toBe(`git_pushed:landed`);
      expect(logs[0].exitCode).toBe(0);
    } finally {
      await rm(bareDir, { recursive: true, force: true });
      await rm(workDir, { recursive: true, force: true });
    }
  });

  it("kind=git_pushed fails verification when the branch was never pushed", async () => {
    const git = promisify(execFile);
    const bareDir = await mkdtemp(join(tmpdir(), "relai-gpv-sched-bare2-"));
    const workDir = await mkdtemp(join(tmpdir(), "relai-gpv-sched-work2-"));
    try {
      await git("git", ["init", "--bare", "-q", bareDir]);
      await git("git", ["init", "-q", workDir]);
      await git("git", ["config", "user.email", "test@example.com"], { cwd: workDir });
      await git("git", ["config", "user.name", "Test"], { cwd: workDir });
      await git("git", ["remote", "add", "origin", bareDir], { cwd: workDir });
      await writeFile(join(workDir, "f.txt"), "x");
      await git("git", ["add", "."], { cwd: workDir });
      await git("git", ["commit", "-q", "-m", "init"], { cwd: workDir });
      await git("git", ["checkout", "-q", "-b", "never-pushed"], { cwd: workDir });

      const create = await app.inject({
        method: "POST", url: "/tasks", headers: ADMIN,
        body: JSON.stringify({
          repoId, createdBy: agentId, title: "gp-miss", description: "x",
          assignedTo: agentId,
          verifyKind: "git_pushed",
          verifyPath: "never-pushed",
          verifyCwd:  workDir,
        }),
      });
      const taskId = create.json().data.id;
      await app.inject({
        method: "PUT", url: `/tasks/${taskId}`, headers: ADMIN,
        body: JSON.stringify({ status: "completed" }),
      });

      const db = createDb(DB_URL);
      await verifyPending(db, repoId);

      const [row] = await db.select().from(tasks).where(eq(tasks.id, taskId));
      expect(row.status).toBe("assigned");
      const meta = row.metadata as Record<string, unknown>;
      const last = meta.lastVerification as { exitCode: number };
      expect(last.exitCode).not.toBe(0);
    } finally {
      await rm(bareDir, { recursive: true, force: true });
      await rm(workDir, { recursive: true, force: true });
    }
  });

  it("kind=git_pushed resolves the remote via the repo's repoUrl, independent of verifyCwd", async () => {
    // No real https/ssh endpoint is available in CI, so this doesn't assert
    // a successful match — it asserts that repoUrl wiring was actually used
    // (hits the protocol-blocked, *retryable* path) rather than the
    // "neither repoUrl nor verifyCwd" *hard-fail* path, which is what would
    // happen if the scheduler's repoUrl DB-lookup silently failed.
    const repoWithUrl = await app.inject({
      method: "POST", url: "/repos", headers: ADMIN,
      body: JSON.stringify({ name: "__test__ repourl" }),
    });
    const repoId2 = repoWithUrl.json().data.id;
    // Write a local path directly via the DB (bypassing the route's
    // https/ssh schema restriction, which is covered separately in
    // repos.test.ts) — only the scheduler's lookup wiring is under test here.
    await createDb(DB_URL).update(repos).set({ repoUrl: "/no/such/remote-xyz" }).where(eq(repos.id, repoId2));

    const a2 = await app.inject({
      method: "POST", url: "/agents", headers: ADMIN,
      body: JSON.stringify({ repoId: repoId2, name: "repourl-agent", role: "worker" }),
    });
    const agentId2 = a2.json().data.id;

    const create = await app.inject({
      method: "POST", url: "/tasks", headers: ADMIN,
      body: JSON.stringify({
        repoId: repoId2, createdBy: agentId2, title: "gp-repourl", description: "x",
        assignedTo: agentId2,
        verifyKind: "git_pushed",
        verifyPath: "whatever",
        // No verifyCwd at all — only resolvable via repoUrl.
      }),
    });
    const taskId = create.json().data.id;
    await app.inject({
      method: "PUT", url: `/tasks/${taskId}`, headers: ADMIN,
      body: JSON.stringify({ status: "completed" }),
    });

    const db = createDb(DB_URL);
    await verifyPending(db, repoId2);

    const [row] = await db.select().from(tasks).where(eq(tasks.id, taskId));
    // Still pending_verification (released, retryable) — proves it took the
    // protocol-blocked-remote path, not the immediate "neither" hard-fail.
    expect(row.status).toBe("pending_verification");
    const meta = row.metadata as Record<string, unknown>;
    expect(meta.verifyRetryCount).toBe(1);

    await app.inject({ method: "DELETE", url: `/repos/${repoId2}`, headers: ADMIN });
  });

  it("kind=git_pushed treats no-repoUrl-and-no-verifyCwd as a hard failure, not a process.cwd() guess", async () => {
    const create = await app.inject({
      method: "POST", url: "/tasks", headers: ADMIN,
      body: JSON.stringify({
        repoId, createdBy: agentId, title: "gp-unresolvable", description: "x",
        assignedTo: agentId,
        verifyKind: "git_pushed",
        verifyPath: "whatever",
        // No verifyCwd, and this suite's `repoId` repo has no repoUrl set.
      }),
    });
    const taskId = create.json().data.id;
    await app.inject({
      method: "PUT", url: `/tasks/${taskId}`, headers: ADMIN,
      body: JSON.stringify({ status: "completed" }),
    });

    const db = createDb(DB_URL);
    await verifyPending(db, repoId);

    const [row] = await db.select().from(tasks).where(eq(tasks.id, taskId));
    expect(row.status).toBe("assigned");
    const logs = await db.select().from(verificationLog).where(eq(verificationLog.taskId, taskId));
    expect(logs[0].stderr).toContain("neither");
  });

  it("kind=git_pushed releases the claim and retries (no log row) on a single transient failure", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "relai-gpv-sched-norepo2-"));
    const create = await app.inject({
      method: "POST", url: "/tasks", headers: ADMIN,
      body: JSON.stringify({
        repoId, createdBy: agentId, title: "gp-retry", description: "x",
        assignedTo: agentId,
        verifyKind: "git_pushed",
        verifyPath: "whatever",
        verifyCwd: cwd,
      }),
    });
    const taskId = create.json().data.id;
    await app.inject({
      method: "PUT", url: `/tasks/${taskId}`, headers: ADMIN,
      body: JSON.stringify({ status: "completed" }),
    });

    const db = createDb(DB_URL);
    const events: AppEvent[] = [];
    const handler = (e: AppEvent) => events.push(e);
    bus.on("event", handler);
    await verifyPending(db, repoId);
    bus.off("event", handler);

    const [row] = await db.select().from(tasks).where(eq(tasks.id, taskId));
    // Still pending_verification — released, not bounced to assigned, and no
    // verification_log row for an inconclusive (not-a-repo) tick.
    expect(row.status).toBe("pending_verification");
    expect(row.verifyingAt).toBeNull();
    const meta = row.metadata as Record<string, unknown>;
    expect(meta.verifyRetryCount).toBe(1);
    const logs = await db.select().from(verificationLog).where(eq(verificationLog.taskId, taskId));
    expect(logs.length).toBe(0);
    // A retryable tick is invisible by design — no notification either.
    expect(events.find((e) => e.kind === "task.verification_failed" && e.targetId === taskId)).toBeUndefined();
    await rm(cwd, { recursive: true, force: true });
  });

  it("kind=git_pushed stops retrying after the cap and surfaces a hard failure", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "relai-gpv-sched-norepo-"));
    const create = await app.inject({
      method: "POST", url: "/tasks", headers: ADMIN,
      body: JSON.stringify({
        repoId, createdBy: agentId, title: "gp-retry-cap", description: "x",
        assignedTo: agentId,
        verifyKind: "git_pushed",
        verifyPath: "whatever",
        verifyCwd: cwd,
      }),
    });
    const taskId = create.json().data.id;
    await app.inject({
      method: "PUT", url: `/tasks/${taskId}`, headers: ADMIN,
      body: JSON.stringify({ status: "completed" }),
    });

    const db = createDb(DB_URL);
    const events: AppEvent[] = [];
    const handler = (e: AppEvent) => events.push(e);
    bus.on("event", handler);
    for (let i = 0; i < 5; i++) {
      await verifyPending(db, repoId);
    }
    bus.off("event", handler);

    const [row] = await db.select().from(tasks).where(eq(tasks.id, taskId));
    expect(row.status).toBe("assigned");
    const meta = row.metadata as Record<string, unknown>;
    expect(meta.verifyRetryCount).toBe(0);
    const last = meta.lastVerification as { retriesExhausted: boolean };
    expect(last.retriesExhausted).toBe(true);
    // The exhausted-cap tick is a real failure — it must notify, unlike the
    // retryable ticks leading up to it.
    const failed = events.find((e) => e.kind === "task.verification_failed" && e.targetId === taskId);
    expect(failed).toBeDefined();
    await rm(cwd, { recursive: true, force: true });
  });

  it("kind=thread_concluded passes when the referenced thread is concluded", async () => {
    const t = await app.inject({
      method: "POST", url: "/threads", headers: ADMIN,
      body: JSON.stringify({ repoId, title: "plan" }),
    });
    const threadId = t.json().data.id;

    const create = await app.inject({
      method: "POST", url: "/tasks", headers: ADMIN,
      body: JSON.stringify({
        repoId, createdBy: agentId, title: "tc", description: "x",
        assignedTo: agentId,
        verifyKind:     "thread_concluded",
        verifyThreadId: threadId,
      }),
    });
    const taskId = create.json().data.id;
    await app.inject({
      method: "PUT", url: `/tasks/${taskId}`, headers: ADMIN,
      body: JSON.stringify({ status: "completed" }),
    });

    // Conclude the thread.
    await app.inject({
      method: "PUT", url: `/threads/${threadId}/conclude`, headers: ADMIN,
      body: JSON.stringify({ summary: "all good" }),
    });

    const db = createDb(DB_URL);
    let shellExecCalled = false;
    await verifyPending(db, repoId, async () => {
      shellExecCalled = true;
      return { exitCode: 0, stdout: "", stderr: "", durationMs: 0, timedOut: false };
    });

    expect(shellExecCalled).toBe(false);
    const [row] = await db.select().from(tasks).where(eq(tasks.id, taskId));
    expect(row.status).toBe("completed");
    const logs = await db.select().from(verificationLog).where(eq(verificationLog.taskId, taskId));
    expect(logs[0].command).toBe(`thread_concluded:${threadId}`);
    expect(logs[0].exitCode).toBe(0);
  });

  it("kind=thread_concluded fails when the thread is still open", async () => {
    const t = await app.inject({
      method: "POST", url: "/threads", headers: ADMIN,
      body: JSON.stringify({ repoId, title: "open-plan" }),
    });
    const threadId = t.json().data.id;

    const create = await app.inject({
      method: "POST", url: "/tasks", headers: ADMIN,
      body: JSON.stringify({
        repoId, createdBy: agentId, title: "tc-open", description: "x",
        assignedTo: agentId,
        verifyKind:     "thread_concluded",
        verifyThreadId: threadId,
      }),
    });
    const taskId = create.json().data.id;
    await app.inject({
      method: "PUT", url: `/tasks/${taskId}`, headers: ADMIN,
      body: JSON.stringify({ status: "completed" }),
    });

    const db = createDb(DB_URL);
    await verifyPending(db, repoId);

    const [row] = await db.select().from(tasks).where(eq(tasks.id, taskId));
    expect(row.status).toBe("assigned");
    const meta = row.metadata as Record<string, unknown>;
    expect((meta.lastVerification as { exitCode: number }).exitCode).toBe(1);
  });

  it("kind=reviewer_agent passes when an approve decision is recorded", async () => {
    // Reviewer agent in the same project.
    const reviewer = await app.inject({
      method: "POST", url: "/agents", headers: ADMIN,
      body: JSON.stringify({ repoId, name: "rev-approve", role: "worker" }),
    });
    const reviewerId = reviewer.json().data.id;

    const create = await app.inject({
      method: "POST", url: "/tasks", headers: ADMIN,
      body: JSON.stringify({
        repoId, createdBy: agentId, title: "ra", description: "x",
        assignedTo: agentId,
        verifyKind:       "reviewer_agent",
        verifyReviewerId: reviewerId,
      }),
    });
    const taskId = create.json().data.id;
    await app.inject({
      method: "PUT", url: `/tasks/${taskId}`, headers: ADMIN,
      body: JSON.stringify({ status: "completed" }),
    });

    const db = createDb(DB_URL);

    // First tick — no decision yet → row should remain pending_verification
    // with verifyingAt cleared, no log row written.
    let shellExecCalled = false;
    await verifyPending(db, repoId, async () => {
      shellExecCalled = true;
      return { exitCode: 0, stdout: "", stderr: "", durationMs: 0, timedOut: false };
    });
    expect(shellExecCalled).toBe(false);
    {
      const [row] = await db.select().from(tasks).where(eq(tasks.id, taskId));
      expect(row.status).toBe("pending_verification");
      expect(row.verifyingAt).toBeNull();
      const logs = await db.select().from(verificationLog).where(eq(verificationLog.taskId, taskId));
      expect(logs.length).toBe(0);
    }

    // Inject the approval directly via the same metadata shape the route writes.
    await db.update(tasks)
      .set({ metadata: { review: { decision: "approve", reviewerId, decidedAt: new Date().toISOString() } } })
      .where(eq(tasks.id, taskId));

    await verifyPending(db, repoId);
    const [row] = await db.select().from(tasks).where(eq(tasks.id, taskId));
    expect(row.status).toBe("completed");
    const logs = await db.select().from(verificationLog).where(eq(verificationLog.taskId, taskId));
    expect(logs[0].command).toBe(`reviewer_agent:${reviewerId}`);
    expect(logs[0].exitCode).toBe(0);
  });

  it("kind=reviewer_agent fails when a reject decision is recorded", async () => {
    const reviewer = await app.inject({
      method: "POST", url: "/agents", headers: ADMIN,
      body: JSON.stringify({ repoId, name: "rev-reject", role: "worker" }),
    });
    const reviewerId = reviewer.json().data.id;

    const create = await app.inject({
      method: "POST", url: "/tasks", headers: ADMIN,
      body: JSON.stringify({
        repoId, createdBy: agentId, title: "ra-rej", description: "x",
        assignedTo: agentId,
        verifyKind:       "reviewer_agent",
        verifyReviewerId: reviewerId,
      }),
    });
    const taskId = create.json().data.id;
    await app.inject({
      method: "PUT", url: `/tasks/${taskId}`, headers: ADMIN,
      body: JSON.stringify({ status: "completed" }),
    });

    const db = createDb(DB_URL);
    await db.update(tasks)
      .set({ metadata: { review: { decision: "reject", reviewerId, decidedAt: new Date().toISOString(), note: "needs tests" } } })
      .where(eq(tasks.id, taskId));

    await verifyPending(db, repoId);
    const [row] = await db.select().from(tasks).where(eq(tasks.id, taskId));
    expect(row.status).toBe("assigned");
    const meta = row.metadata as Record<string, unknown>;
    expect((meta.lastVerification as { exitCode: number }).exitCode).toBe(1);
  });

  it("emits task.review_overdue once when a reviewer task awaits past the threshold", async () => {
    const reviewer = await app.inject({
      method: "POST", url: "/agents", headers: ADMIN,
      body: JSON.stringify({ repoId, name: "rev-overdue", role: "worker" }),
    });
    const reviewerId = reviewer.json().data.id;
    const create = await app.inject({
      method: "POST", url: "/tasks", headers: ADMIN,
      body: JSON.stringify({
        repoId, createdBy: agentId, title: "ra-overdue", description: "x",
        assignedTo: agentId, verifyKind: "reviewer_agent", verifyReviewerId: reviewerId,
      }),
    });
    const taskId = create.json().data.id;
    // → pending_verification, with NO review decision recorded.
    await app.inject({
      method: "PUT", url: `/tasks/${taskId}`, headers: ADMIN,
      body: JSON.stringify({ status: "completed" }),
    });

    const captured: AppEvent[] = [];
    const handler = (e: AppEvent) => captured.push(e);
    bus.on("event", handler);
    const prev = process.env.REVIEW_OVERDUE_MS;
    process.env.REVIEW_OVERDUE_MS = "0"; // any wait counts as overdue
    try {
      const db = createDb(DB_URL);
      await verifyPending(db, repoId); // emits + sets the flag
      await verifyPending(db, repoId); // flag set → must NOT re-emit

      const overdue = captured.filter((e) => e.kind === "task.review_overdue" && e.targetId === taskId);
      expect(overdue).toHaveLength(1);
      const [row] = await db.select().from(tasks).where(eq(tasks.id, taskId));
      expect(row.status).toBe("pending_verification"); // still awaiting — unchanged
      expect((row.metadata as Record<string, unknown>).reviewOverdueNotifiedAt).toBeDefined();
    } finally {
      bus.off("event", handler);
      if (prev === undefined) delete process.env.REVIEW_OVERDUE_MS;
      else process.env.REVIEW_OVERDUE_MS = prev;
    }
  });

  it("recovers stuck claims older than the threshold", async () => {
    const taskId = await makePendingVerificationTask("noop-stuck");
    const db = createDb(DB_URL);

    // Simulate a crashed predicate run by back-dating verifyingAt and forcing
    // status back to pending_verification.
    await db.update(tasks)
      .set({
        status: "pending_verification",
        verifyingAt: new Date(Date.now() - 6 * 60 * 1000),
      })
      .where(eq(tasks.id, taskId));

    let execCalled = false;
    await verifyPending(db, repoId, async () => {
      execCalled = true;
      return { exitCode: 0, stdout: "", stderr: "", durationMs: 0, timedOut: false };
    });

    // Stuck recovery should NOT invoke the executor — it synthesizes a timed-out result.
    expect(execCalled).toBe(false);

    const [row] = await db.select().from(tasks).where(eq(tasks.id, taskId));
    expect(row.status).toBe("assigned");

    const logs = await db.select().from(verificationLog).where(eq(verificationLog.taskId, taskId));
    const stuck = logs.find((l) => l.timedOut === true);
    expect(stuck).toBeDefined();
  });
});
