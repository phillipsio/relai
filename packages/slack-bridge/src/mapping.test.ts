import { describe, it, expect } from "vitest";
import { isSelfMessage, resolveFromAgent, renderEvent } from "./mapping.js";
import type { AppEvent } from "./types.js";

function evt(kind: string, payload: Record<string, unknown>): AppEvent {
  return {
    id: "evt_1",
    kind,
    repoId: "repo_1",
    targetType: "task",
    targetId: "task_1",
    payload,
    createdAt: "2026-07-15T00:00:00Z",
  };
}

describe("isSelfMessage (loop guard)", () => {
  it("matches our bot user id", () => {
    expect(isSelfMessage({ user: "U1" }, { userId: "U1" })).toBe(true);
  });
  it("matches our bot id", () => {
    expect(isSelfMessage({ bot_id: "B1" }, { botId: "B1" })).toBe(true);
  });
  it("does NOT match a different bot — a teammate's Claude is ingested (hybrid)", () => {
    expect(isSelfMessage({ user: "U2", bot_id: "B2" }, { userId: "U1", botId: "B1" })).toBe(false);
  });
  it("does not match when self identity is unknown", () => {
    expect(isSelfMessage({ user: "U1" }, {})).toBe(false);
  });
});

describe("resolveFromAgent (identity map)", () => {
  const map = { U1: "agent_alice" };
  it("maps a known Slack user to its agent id", () => {
    expect(resolveFromAgent("U1", map)).toBe("agent_alice");
  });
  it("falls back to human for unknown users (blocked-watcher resume key)", () => {
    expect(resolveFromAgent("U9", map)).toBe("human");
  });
  it("falls back to human when the user id is missing", () => {
    expect(resolveFromAgent(undefined, map)).toBe("human");
  });
});

describe("renderEvent (outbound selection + formatting)", () => {
  const opts = { agentNames: { agent_alice: "Alice" } };

  it("renders a posted message under the author's display name", () => {
    const post = renderEvent(evt("message.posted", { message: { body: "hello", fromAgent: "agent_alice" } }), opts);
    expect(post).toEqual({ text: "hello", username: "Alice", iconEmoji: ":speech_balloon:" });
  });

  it("suppresses Slack-originated messages (echo guard)", () => {
    const post = renderEvent(
      evt("message.posted", { message: { body: "hi", fromAgent: "human", metadata: { source: "slack" } } }),
      opts,
    );
    expect(post).toBeNull();
  });

  it("renders task.blocked as an Input required ping carrying the reason", () => {
    const post = renderEvent(
      evt("task.blocked", { task: { title: "Fix CORS", metadata: { blockedReason: "need prod token" } } }),
      opts,
    );
    expect(post?.text).toContain("Input required");
    expect(post?.text).toContain("Fix CORS");
    expect(post?.text).toContain("need prod token");
  });

  it("surfaces task.updated only for status transitions", () => {
    expect(
      renderEvent(evt("task.updated", { task: { title: "T", status: "in_progress" }, changes: { priority: "high" } }), opts),
    ).toBeNull();
    const post = renderEvent(
      evt("task.updated", { task: { title: "T", status: "in_progress" }, changes: { status: "in_progress" } }),
      opts,
    );
    expect(post?.text).toContain("Running");
  });

  it("renders task.verified as Done", () => {
    const post = renderEvent(evt("task.verified", { task: { title: "Ship it" } }), opts);
    expect(post?.text).toContain("Done");
    expect(post?.text).toContain("Ship it");
  });

  it("hides internal kinds from the channel", () => {
    expect(renderEvent(evt("task.stalled", { task: {} }), opts)).toBeNull();
    expect(renderEvent(evt("thread.created", { thread: {} }), opts)).toBeNull();
    expect(renderEvent(evt("task.proposed", { task: {} }), opts)).toBeNull();
  });
});
