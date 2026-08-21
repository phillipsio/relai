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

// `prev === null` is the first run: summarise, or opening a session fires dozens.
// Tasks leaving the set are dropped, so re-entry notifies again.
export function diffAttention(
  prev: Map<string, AttentionState> | null,
  tasks: WatchTask[],
): { notices: string[]; next: Map<string, AttentionState> } {
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
      notices: [`relai: ${next.size} item(s) need you (${parts.join(", ")}). Call list_attention.`],
      next,
    };
  }

  const byId = new Map(tasks.map((t) => [t.id, t]));
  const notices: string[] = [];
  for (const [id, state] of next) {
    if (prev.get(id) !== state) notices.push(describe(byId.get(id)!, state));
  }
  return { notices, next };
}
