import { describe, it, expect } from "vitest";
import { parseSseFrame, summarize, truncate, formatEvent, consumeEventStream, type WatchEvent } from "./watch.js";

function streamFrom(chunks: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  let i = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i < chunks.length) controller.enqueue(enc.encode(chunks[i++]));
      else controller.close();
    },
  });
}

function evt(overrides: Partial<WatchEvent> = {}): WatchEvent {
  return {
    id: "evt_1",
    kind: "task.created",
    projectId: "proj_1",
    targetType: "task",
    targetId: "task_1",
    payload: {},
    createdAt: "2026-05-31T12:00:00.000Z",
    ...overrides,
  };
}

describe("parseSseFrame", () => {
  it("returns null for comment/heartbeat frames", () => {
    expect(parseSseFrame(": ping")).toBeNull();
    expect(parseSseFrame(": connected")).toBeNull();
  });

  it("returns null for a frame with no data line", () => {
    expect(parseSseFrame("event: task.created\nid: evt_1")).toBeNull();
  });

  it("parses an event from a well-formed frame", () => {
    const frame = `event: task.created\nid: evt_9\ndata: ${JSON.stringify(evt({ id: "evt_9" }))}`;
    const parsed = parseSseFrame(frame);
    expect(parsed?.id).toBe("evt_9");
    expect(parsed?.kind).toBe("task.created");
  });

  it("concatenates multi-line data payloads", () => {
    const json = JSON.stringify(evt());
    const half = Math.floor(json.length / 2);
    const frame = `data: ${json.slice(0, half)}\ndata: ${json.slice(half)}`;
    expect(parseSseFrame(frame)?.id).toBe("evt_1");
  });

  it("returns null on malformed JSON", () => {
    expect(parseSseFrame("data: {not json")).toBeNull();
  });
});

describe("summarize", () => {
  it("summarizes a posted message with sender + type + body", () => {
    const s = summarize(evt({
      kind: "message.posted",
      targetType: "thread",
      payload: { message: { type: "handoff", fromAgent: "gemini", body: "module 6 done" } },
    }));
    expect(s).toContain("handoff");
    expect(s).toContain("gemini");
    expect(s).toContain("module 6 done");
  });

  it("summarizes a new task by title", () => {
    const s = summarize(evt({ kind: "task.created", payload: { task: { title: "Extract module 7" } } }));
    expect(s).toContain("Extract module 7");
    expect(s.toLowerCase()).toContain("assigned");
  });

  it("summarizes a review decision", () => {
    const s = summarize(evt({
      kind: "task.review_submitted",
      payload: { task: { title: "PR #4" }, review: { decision: "approve" } },
    }));
    expect(s).toContain("approve");
    expect(s).toContain("PR #4");
  });

  it("falls back to target identity for unknown kinds", () => {
    expect(summarize(evt({ kind: "something.weird", targetType: "task", targetId: "task_42" })))
      .toBe("task task_42");
  });
});

describe("truncate", () => {
  it("collapses whitespace and leaves short strings intact", () => {
    expect(truncate("a   b\nc", 80)).toBe("a b c");
  });

  it("truncates long strings with an ellipsis", () => {
    const out = truncate("x".repeat(100), 10);
    expect(out).toHaveLength(10);
    expect(out.endsWith("…")).toBe(true);
  });
});

describe("formatEvent", () => {
  it("includes a clock time, the kind, and the summary", () => {
    const line = formatEvent(evt({ kind: "task.created", payload: { task: { title: "Do thing" } } }));
    expect(line).toContain("task.created");
    expect(line).toContain("Do thing");
  });
});

describe("consumeEventStream", () => {
  it("emits parsed events, joins frames split across chunks, and skips heartbeats", async () => {
    const e1 = JSON.stringify(evt({ id: "evt_a", kind: "task.created" }));
    const e2 = JSON.stringify(evt({ id: "evt_b", kind: "message.posted" }));
    const chunks = [
      ": connected\n\n",
      // one chunk: a full event, a heartbeat comment, then the START of e2's frame
      `event: task.created\ndata: ${e1}\n\n: ping\n\nevent: message.posted\ndata: ${e2.slice(0, 12)}`,
      // next chunk completes e2's frame
      `${e2.slice(12)}\n\n`,
    ];
    const seen: WatchEvent[] = [];
    await consumeEventStream(streamFrom(chunks), (e) => seen.push(e));
    expect(seen.map((e) => e.id)).toEqual(["evt_a", "evt_b"]);
  });
});
