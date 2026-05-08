import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildServer } from "../../server.js";
import { verifyPending } from "./scheduler.js";
import { bus, type AppEvent } from "../events.js";
import { createDb, tasks, verificationLog } from "@getrelai/db";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";

const DB_URL = process.env.DATABASE_URL ?? "postgresql://relai:relai@localhost:5433/relai";
const SECRET = "test-secret-verify";

process.env.DATABASE_URL = DB_URL;
process.env.API_SECRET   = SECRET;

const ADMIN = { Authorization: `Bearer ${SECRET}`, "Content-Type": "application/json" };

let app: FastifyInstance;
let projectId: string;
let agentId: string;

beforeAll(async () => {
  app = buildServer({ logger: false, scheduler: false });
  await app.ready();

  const project = await app.inject({
    method: "POST", url: "/projects", headers: ADMIN,
    body: JSON.stringify({ name: "__test__ verify" }),
  });
  projectId = project.json().data.id;

  const a = await app.inject({
    method: "POST", url: "/agents", headers: ADMIN,
    body: JSON.stringify({ projectId, name: "verify-agent", role: "worker" }),
  });
  agentId = a.json().data.id;
});

afterAll(async () => {
  if (projectId) {
    await app.inject({ method: "DELETE", url: `/projects/${projectId}`, headers: ADMIN });
  }
  await app?.close();
});

async function makePendingVerificationTask(verifyCommand: string, verifyTimeoutMs?: number): Promise<string> {
  const create = await app.inject({
    method: "POST", url: "/tasks", headers: ADMIN,
    body: JSON.stringify({
      projectId, createdBy: agentId, title: "verify-test", description: "x",
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

    await verifyPending(db, projectId, async () => ({
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

    await verifyPending(db, projectId, async () => ({
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
    await verifyPending(db, projectId, async (command, _cwd, timeoutMs) => {
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
          projectId, createdBy: agentId, title: "fx", description: "x",
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
      await verifyPending(db, projectId, async () => {
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
          projectId, createdBy: agentId, title: "fx-miss", description: "x",
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
      await verifyPending(db, projectId);

      const [row] = await db.select().from(tasks).where(eq(tasks.id, taskId));
      expect(row.status).toBe("assigned");
      const meta = row.metadata as Record<string, unknown>;
      const last = meta.lastVerification as { exitCode: number };
      expect(last.exitCode).toBe(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
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
    await verifyPending(db, projectId, async () => {
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
