import type { OrchestratorApiClient } from "./api-client.js";
import type { OrchestratorConfig } from "./config.js";

export async function runBlockedTaskWatch(
  apiClient: OrchestratorApiClient,
  config: OrchestratorConfig,
): Promise<void> {
  try {
    const blocked = await apiClient.getBlockedTasks(config.projectId);
    const watchable = blocked.filter(
      (t) => typeof t.metadata.blockedThreadId === "string",
    );

    if (watchable.length === 0) return;

    for (const task of watchable) {
      const threadId = task.metadata.blockedThreadId as string;
      const messages = await apiClient.getThreadMessages(threadId);

      // Find any human reply posted after the task was last updated
      const taskUpdatedAt = new Date(task.createdAt).getTime();
      const humanReply = messages.find(
        (m) => m.fromAgent === "human" && new Date(m.createdAt).getTime() > taskUpdatedAt,
      );

      if (!humanReply) continue;

      console.log(`[orchestrator] Human replied to blocked task ${task.id} — resuming`);

      await apiClient.resumeTask(task.id, {
        ...task.metadata,
        humanReply: humanReply.body,
        humanRepliedAt: humanReply.createdAt,
      });
    }
  } catch (err) {
    console.error("[orchestrator] Blocked task watch error:", err);
  }
}
