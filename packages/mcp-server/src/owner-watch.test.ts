import { describe, it, expect, vi } from "vitest";
import { attentionStateOf, diffAttention, deliverAttention, type AttentionState, type WatchTask } from "./owner-watch.js";

const task = (over: Partial<WatchTask> = {}): WatchTask => ({
  id: "task_1", title: "do the thing", repoId: "repo_a", status: "assigned", ...over,
});

describe("what counts as needing the owner", () => {
  it("picks up the four states and ignores healthy work", () => {
    expect(attentionStateOf(task({ status: "blocked" }))).toBe("blocked");
    expect(attentionStateOf(task({ status: "pending_verification" }))).toBe("pending_verification");
    expect(attentionStateOf(task({ status: "proposed" }))).toBe("proposed");
    expect(attentionStateOf(task({ status: "in_progress", stalledAt: "2026-07-08T00:00:00Z" }))).toBe("stalled");

    expect(attentionStateOf(task({ status: "in_progress" }))).toBeNull();
    expect(attentionStateOf(task({ status: "assigned" }))).toBeNull();
    expect(attentionStateOf(task({ status: "completed" }))).toBeNull();
  });

  // Silence is the failure mode the whole poll exists for: a stalled task
  // emits nothing anyone subscribes to.
  it("treats a stalled task as needing attention even though its status looks fine", () => {
    expect(attentionStateOf(task({ status: "in_progress", stalledAt: "2026-07-08T00:00:00Z" }))).toBe("stalled");
  });

  it("reports a stalled blocked task as blocked, since that is what you act on", () => {
    expect(attentionStateOf(task({ status: "blocked", stalledAt: "2026-07-08T00:00:00Z" }))).toBe("blocked");
  });
});

describe("first run", () => {
  it("summarises instead of firing one notification per item", () => {
    const tasks = [
      task({ id: "t1", status: "blocked" }),
      task({ id: "t2", status: "blocked" }),
      task({ id: "t3", status: "proposed" }),
      ...Array.from({ length: 22 }, (_, i) => task({ id: `s${i}`, status: "in_progress", stalledAt: "2026-07-08T00:00:00Z" })),
    ];
    const { notices, next } = diffAttention(null, tasks);

    expect(notices).toHaveLength(1);
    expect(notices[0].text).toContain("25 item(s) need you");
    expect(notices[0].text).toContain("2 blocked");
    expect(notices[0].text).toContain("22 stalled");
    expect(notices[0].text).toContain("list_attention");
    expect(next.size).toBe(25);
  });

  it("says nothing when nothing needs you", () => {
    expect(diffAttention(null, [task({ status: "in_progress" })]).notices).toEqual([]);
  });
});

describe("subsequent runs notify on every transition", () => {
  const seed = (entries: Array<[string, AttentionState]>) => new Map(entries);

  it("notifies when a task enters an attention state", () => {
    const { notices } = diffAttention(seed([]), [task({ id: "t1", status: "blocked", title: "auth model call" })]);
    expect(notices).toHaveLength(1);
    expect(notices[0].text).toContain("auth model call");
    expect(notices[0].text).toContain("BLOCKED");
    expect(notices[0].text).toContain("(t1)");   // the id, so you can act on it from a phone
  });

  it("stays quiet while a task sits in the same state", () => {
    const { notices } = diffAttention(seed([["t1", "blocked"]]), [task({ id: "t1", status: "blocked" })]);
    expect(notices).toEqual([]);
  });

  it("notifies when a task moves between attention states", () => {
    const { notices } = diffAttention(seed([["t1", "proposed"]]), [task({ id: "t1", status: "blocked" })]);
    expect(notices).toHaveLength(1);
    expect(notices[0].text).toContain("BLOCKED");
  });

  // blocked -> answered -> blocked again is two things you need to know about,
  // so leaving the set has to forget the task.
  it("notifies again when a task re-enters a state it had left", () => {
    const first = diffAttention(seed([["t1", "blocked"]]), [task({ id: "t1", status: "assigned" })]);
    expect(first.notices).toEqual([]);
    expect(first.next.has("t1")).toBe(false);

    const second = diffAttention(first.next, [task({ id: "t1", status: "blocked" })]);
    expect(second.notices).toHaveLength(1);
  });

  it("hands a blocked task the thread to reply on", () => {
    const { notices } = diffAttention(seed([]), [
      task({ id: "t1", status: "blocked", metadata: { blockedThreadId: "thread_xyz" } }),
    ]);
    expect(notices[0].text).toContain("thread_xyz");
  });

  it("names the tool to use for each state", () => {
    const one = (t: WatchTask) => diffAttention(seed([]), [t]).notices[0].text;
    expect(one(task({ status: "proposed" }))).toContain("commit_proposal");
    expect(one(task({ status: "pending_verification" }))).toContain("review_task");
    expect(one(task({ status: "in_progress", stalledAt: "2026-07-08T00:00:00Z" }))).toContain("reassign or cancel");
  });

  it("carries the repo, since the operator spans several", () => {
    const { notices } = diffAttention(seed([]), [task({ status: "blocked", repoId: "repo_frontend" })]);
    expect(notices[0].text).toContain("repo_frontend");
  });
});

describe("a notice that fails to send is retried, not dropped", () => {
  const blocked = (id: string) => task({ id, status: "blocked", title: id });
  const notConnected = () => Promise.reject(new Error("Not connected"));

  it("re-sends a transition whose send threw", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const prev = new Map<string, AttentionState>();
    const afterFail = await deliverAttention(prev, [blocked("t1")], notConnected);
    const sent: string[] = [];
    await deliverAttention(afterFail, [blocked("t1")], async (t) => { sent.push(t); });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("(t1)");
  });

  it("keeps the rest of the batch when one send throws", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const sent: string[] = [];
    const after = await deliverAttention(new Map(), [blocked("t1"), blocked("t2")], async (t) => {
      if (t.includes("(t1)")) throw new Error("Not connected");
      sent.push(t);
    });
    expect(sent.some((t) => t.includes("(t2)"))).toBe(true);
    const retry: string[] = [];
    await deliverAttention(after, [blocked("t1"), blocked("t2")], async (t) => { retry.push(t); });
    expect(retry).toHaveLength(1);
    expect(retry[0]).toContain("(t1)");
  });

  it("retries the first-run summary when it could not be sent", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await deliverAttention(null, [blocked("t1")], notConnected)).toBeNull();
  });

  it("does not re-send what was delivered", async () => {
    const after = await deliverAttention(new Map(), [blocked("t1")], async () => {});
    const again: string[] = [];
    await deliverAttention(after, [blocked("t1")], async (t) => { again.push(t); });
    expect(again).toEqual([]);
  });
});
