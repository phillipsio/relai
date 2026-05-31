import chalk from "chalk";
import { requireConfig } from "../config.js";
import { CliApiClient } from "../api.js";

export interface WatchEvent {
  id: string;
  kind: string;
  projectId: string;
  targetType: string;
  targetId: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

// ── pure helpers (unit-tested) ────────────────────────────────────────────────

export function truncate(s: string, n: number): string {
  const clean = (s ?? "").replace(/\s+/g, " ").trim();
  return clean.length > n ? clean.slice(0, n - 1) + "…" : clean;
}

// Parse one SSE frame (text between blank lines) into an event. Comment lines
// (": ping", ": connected") and frames without a `data:` payload return null.
// `data:` may span multiple lines per the SSE spec; they're concatenated.
export function parseSseFrame(frame: string): WatchEvent | null {
  let data = "";
  for (const line of frame.split("\n")) {
    if (!line || line.startsWith(":")) continue;
    if (line.startsWith("data:")) data += line.slice(5).trimStart();
  }
  if (!data) return null;
  try {
    return JSON.parse(data) as WatchEvent;
  } catch {
    return null;
  }
}

// One-line human summary of an event, derived from its payload.
export function summarize(e: WatchEvent): string {
  const p = (e.payload ?? {}) as {
    task?: { title?: string; status?: string };
    message?: { type?: string; fromAgent?: string; body?: string };
    thread?: { title?: string };
    review?: { decision?: string };
  };
  const taskTitle = p.task?.title ?? e.targetId;
  const threadTitle = p.thread?.title ?? e.targetId;

  switch (e.kind) {
    case "message.posted":
      return `${p.message?.type ?? "message"} from ${p.message?.fromAgent ?? "?"}: ${truncate(p.message?.body ?? "", 80)}`;
    case "task.created":
      return `new task assigned to you: "${taskTitle}"`;
    case "task.updated":
      return `"${taskTitle}" is now ${p.task?.status ?? "?"}`;
    case "task.stalled":
      return `task stalled: "${taskTitle}"`;
    case "task.verified":
      return `"${taskTitle}" passed verification → completed`;
    case "task.verification_failed":
      return `"${taskTitle}" failed verification → back to assigned`;
    case "task.review_requested":
      return `review requested: "${taskTitle}"`;
    case "task.review_submitted":
      return `review ${p.review?.decision ?? "submitted"}: "${taskTitle}"`;
    case "task.review_overdue":
      return `review OVERDUE: "${taskTitle}"`;
    case "thread.created":
      return `new thread: "${threadTitle}"`;
    case "thread.concluded":
      return `thread concluded: "${threadTitle}"`;
    default:
      return `${e.targetType} ${e.targetId}`;
  }
}

const KIND_STYLE: Record<string, (s: string) => string> = {
  "message.posted":           chalk.cyan,
  "task.created":             chalk.green,
  "task.updated":             chalk.blue,
  "task.stalled":             chalk.yellow,
  "task.verified":            chalk.green,
  "task.verification_failed": chalk.red,
  "task.review_requested":    chalk.magenta,
  "task.review_submitted":    chalk.magenta,
  "task.review_overdue":      chalk.yellow,
  "thread.created":           chalk.cyan,
  "thread.concluded":         chalk.dim,
};

function clockOf(iso: string): string {
  const d = new Date(iso);
  return (isNaN(d.getTime()) ? new Date() : d).toLocaleTimeString();
}

export function formatEvent(e: WatchEvent): string {
  const style = KIND_STYLE[e.kind] ?? chalk.white;
  return `${chalk.dim(clockOf(e.createdAt))}  ${style(e.kind.padEnd(26))}  ${summarize(e)}`;
}

// Read an SSE body stream to completion, invoking `onEvent` for each parsed
// event. Resolves when the stream ends (server closed → caller reconnects).
// Handles frames split across chunk boundaries via a carry-over buffer.
export async function consumeEventStream(
  stream: ReadableStream<Uint8Array>,
  onEvent: (e: WatchEvent) => void,
): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let sep: number;
    while ((sep = buffer.indexOf("\n\n")) !== -1) {
      const event = parseSseFrame(buffer.slice(0, sep));
      buffer = buffer.slice(sep + 2);
      if (event) onEvent(event);
    }
  }
}

// ── command ───────────────────────────────────────────────────────────────────

export async function watchCommand(options: { kinds?: string }): Promise<void> {
  const config = requireConfig();
  const client = new CliApiClient(config);

  const kinds = options.kinds
    ? new Set(options.kinds.split(",").map((k) => k.trim()).filter(Boolean))
    : null;

  // Task-assignment events notify our agent-target, but agents aren't
  // auto-subscribed to themselves the way they are to threads they post in.
  // Self-subscribe (idempotent) so `relai watch` actually surfaces new tasks.
  try {
    await client.ensureSubscription(config.agentId, "agent", config.agentId);
  } catch (err) {
    console.error(chalk.yellow(`Warning: could not self-subscribe; new-task events may not show (${(err as Error).message})`));
  }

  console.log(chalk.bold("relai watch") + chalk.dim(` — ${config.agentName} · ${config.projectId}`));
  console.log(chalk.dim(
    `Streaming live events you're subscribed to. Ctrl-C to stop.` +
    (kinds ? ` Filtering: ${[...kinds].join(", ")}` : "") +
    `\n(Past events you missed are in \`relai start\`.)`,
  ));

  let stop = false;
  process.on("SIGINT", () => {
    stop = true;
    console.log(chalk.dim("\nstopped."));
    process.exit(0);
  });

  const url = `${config.apiUrl.replace(/\/$/, "")}/events`;
  let backoffMs = 1_000;

  while (!stop) {
    try {
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${config.apiToken}`, Accept: "text/event-stream" },
      });
      if (!res.ok || !res.body) throw new Error(`event stream returned ${res.status}`);
      backoffMs = 1_000; // reset after a clean connect

      await consumeEventStream(res.body, (event) => {
        if (!kinds || kinds.has(event.kind)) console.log(formatEvent(event));
      });
    } catch (err) {
      if (stop) break;
      console.error(chalk.dim(`disconnected (${(err as Error).message}); reconnecting in ${Math.round(backoffMs / 1000)}s…`));
      await new Promise((r) => setTimeout(r, backoffMs));
      backoffMs = Math.min(backoffMs * 2, 30_000);
    }
  }
}
