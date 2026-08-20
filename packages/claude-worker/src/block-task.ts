// Only the API connection fields are needed, so both ClaudeWorkerConfig and
// EventWorkerConfig satisfy this without either package depending on the other.
type Conn = { apiUrl: string; apiSecret: string; agentId: string; repoId: string };

type TaskRow = { id: string; metadata?: Record<string, unknown> | null };

const DETAIL_CAP = 500;

const BLOCKED_REASON =
  "Session ran out of context window. This task is too large to finish in one session — " +
  "split it into smaller tasks before reassigning it.";

// Sets no blockedThreadId on purpose: the API's resume watcher only revives
// tasks that have one, and an oversized task needs a human, not a retry.
export async function blockOverflowedTasks(
  conn: Conn,
  detail: string,
  logPrefix = "[claude-worker]",
): Promise<string[]> {
  const headers = { "Content-Type": "application/json", Authorization: `Bearer ${conn.apiSecret}` };
  const blocked: string[] = [];

  try {
    const res = await fetch(
      `${conn.apiUrl}/tasks?repoId=${conn.repoId}&assignedTo=${conn.agentId}&status=in_progress`,
      { headers },
    );
    if (!res.ok) throw new Error(`task list failed (${res.status} ${res.statusText})`);
    const { data } = (await res.json()) as { data?: TaskRow[] };

    for (const task of data ?? []) {
      const metadata = {
        ...(task.metadata ?? {}),
        blockedReason: BLOCKED_REASON,
        overflow: { detail: detail.slice(0, DETAIL_CAP) },
      };
      const put = await fetch(`${conn.apiUrl}/tasks/${task.id}`, {
        method: "PUT",
        headers,
        body: JSON.stringify({ status: "blocked", metadata }),
      });
      if (!put.ok) {
        console.error(`${logPrefix} Could not block ${task.id} (${put.status} ${put.statusText})`);
        continue;
      }
      blocked.push(task.id);
    }
  } catch (err) {
    // The caller is already handling a session failure — don't replace it.
    console.error(
      `${logPrefix} Could not block overflowed tasks:`,
      err instanceof Error ? err.message : String(err),
    );
  }

  return blocked;
}
