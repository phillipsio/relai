// Owner-mode inbox: the attention set across every repo, plus stalled work,
// which generates no event anyone was subscribed to.

export type AttentionState = "blocked" | "pending_verification" | "proposed" | "stalled";

export interface WatchTask {
  id:         string;
  title?:     string;
  status?:    string;
  repoId?:    string;
  stalledAt?: string | null;
  metadata?:  Record<string, unknown> | null;
}

const LABEL: Record<AttentionState, string> = {
  blocked:              "BLOCKED, waiting on you",
  pending_verification: "awaiting a review decision",
  proposed:             "awaiting your commit",
  stalled:              "STALLED, no progress",
};

// blocked outranks the rest: a stalled blocked task is still blocked on you.
export function attentionStateOf(task: WatchTask): AttentionState | null {
  if (task.status === "blocked")              return "blocked";
  if (task.status === "pending_verification") return "pending_verification";
  if (task.status === "proposed")             return "proposed";
  if (task.stalledAt)                         return "stalled";
  return null;
}

function describe(task: WatchTask, state: AttentionState): string {
  const title = (task.title ?? task.id).slice(0, 80);
  const where = task.repoId ? ` [${task.repoId}]` : "";
  const thread = state === "blocked" && typeof task.metadata?.blockedThreadId === "string"
    ? ` Reply on thread ${task.metadata.blockedThreadId} to unblock it.`
    : "";
  const next = state === "proposed" ? " Use commit_proposal."
    : state === "pending_verification" ? " Use review_task."
    : state === "stalled" ? " Nobody is coming; reassign or cancel it."
    : "";
  return `relai: "${title}" is ${LABEL[state]}${where} (${task.id}).${thread}${next}`;
}

export interface Notice { text: string; ids: string[] }

// `prev === null` is the first run: summarise, or opening a session fires dozens.
// Tasks leaving the set are dropped, so re-entry notifies again.
export function diffAttention(
  prev: Map<string, AttentionState> | null,
  tasks: WatchTask[],
): { notices: Notice[]; next: Map<string, AttentionState> } {
  const next = new Map<string, AttentionState>();
  for (const t of tasks) {
    const state = attentionStateOf(t);
    if (state) next.set(t.id, state);
  }

  if (prev === null) {
    if (next.size === 0) return { notices: [], next };
    const counts = new Map<AttentionState, number>();
    for (const s of next.values()) counts.set(s, (counts.get(s) ?? 0) + 1);
    const parts = [...counts.entries()].map(([s, n]) => `${n} ${s}`).sort();
    return {
      notices: [{ text: `relai: ${next.size} item(s) need you (${parts.join(", ")}). Call list_attention.`, ids: [...next.keys()] }],
      next,
    };
  }

  const byId = new Map(tasks.map((t) => [t.id, t]));
  const notices: Notice[] = [];
  for (const [id, state] of next) {
    if (prev.get(id) !== state) notices.push({ text: describe(byId.get(id)!, state), ids: [id] });
  }
  return { notices, next };
}

export async function deliverAttention(
  prev: Map<string, AttentionState> | null,
  tasks: WatchTask[],
  send: (text: string) => Promise<unknown>,
): Promise<Map<string, AttentionState> | null> {
  const { notices, next } = diffAttention(prev, tasks);
  const undelivered = new Set<string>();
  for (const [i, n] of notices.entries()) {
    try {
      await send(n.text);
    } catch (err) {
      const held = notices.slice(i);
      console.error(`[relai-mcp] ${held.length} attention notice(s) held for the next poll:`, err instanceof Error ? err.message : err);
      held.forEach((h) => h.ids.forEach((id) => undelivered.add(id)));
      break;
    }
  }
  if (undelivered.size === 0) return next;
  if (prev === null) return null;
  for (const id of undelivered) {
    const before = prev.get(id);
    if (before) next.set(id, before);
    else next.delete(id);
  }
  return next;
}
