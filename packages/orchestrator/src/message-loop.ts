import Anthropic from "@anthropic-ai/sdk";
import type { OrchestratorApiClient, MessageRow } from "./api-client.js";
import type { OrchestratorConfig } from "./config.js";
import {
  MESSAGE_ROUTER_SYSTEM_PROMPT,
  buildMessageRoutingContext,
  MESSAGE_ROUTING_TOOL,
} from "./prompts/message-router.js";

const ONLINE_WINDOW_MS = 10 * 60 * 1000;

function isOnline(lastSeenAt: string): boolean {
  return Date.now() - new Date(lastSeenAt).getTime() < ONLINE_WINDOW_MS;
}

async function claudeMessageRoute(
  msg: MessageRow,
  apiClient: OrchestratorApiClient,
  anthropic: Anthropic,
  config: OrchestratorConfig,
): Promise<Record<string, unknown>> {
  const agents = await apiClient.getWorkerAgents(config.projectId);
  const response = await anthropic.messages.create({
    model: config.model,
    max_tokens: 512,
    system: MESSAGE_ROUTER_SYSTEM_PROMPT,
    tools: [MESSAGE_ROUTING_TOOL],
    tool_choice: { type: "any" },
    messages: [{ role: "user", content: buildMessageRoutingContext(msg, agents) }],
  });

  const toolUse = response.content.find((b) => b.type === "tool_use");
  if (!toolUse || toolUse.type !== "tool_use") {
    throw new Error("Claude did not return a message routing decision");
  }
  return toolUse.input as Record<string, unknown>;
}

async function executeAction(
  action: Record<string, unknown>,
  msg: MessageRow,
  apiClient: OrchestratorApiClient,
  config: OrchestratorConfig,
): Promise<void> {
  switch (action.action) {
    case "create_task":
      await apiClient.createTask({
        projectId: config.projectId,
        createdBy: config.agentId,
        title: action.taskTitle as string,
        description: action.taskDescription as string,
        domains: (action.taskDomains as string[]) ?? [],
        specialization: action.taskSpecialization as string | undefined,
        priority: (action.taskPriority as string) ?? "normal",
        metadata: { sourceThread: msg.threadId, sourceMessage: msg.id, fromAgent: msg.fromAgent },
      });
      console.log(`[message-loop] Created task from ${msg.type}: "${action.taskTitle}"`);
      break;

    case "forward":
      await apiClient.sendMessage(msg.threadId, {
        fromAgent: config.agentId,
        toAgent: action.toAgent as string,
        type: msg.type,
        body: action.messageBody as string,
        metadata: { forwardedFrom: msg.fromAgent, originalMessage: msg.id },
      });
      console.log(`[message-loop] Forwarded ${msg.type} to agent ${action.toAgent}`);
      break;

    case "broadcast": {
      const agents = await apiClient.getWorkerAgents(config.projectId);
      const online = agents.filter((a) => isOnline(a.lastSeenAt));
      for (const agent of online) {
        await apiClient.sendMessage(msg.threadId, {
          fromAgent: config.agentId,
          toAgent: agent.id,
          type: msg.type,
          body: action.messageBody as string,
          metadata: { broadcastFrom: msg.fromAgent, originalMessage: msg.id },
        });
      }
      console.log(`[message-loop] Broadcast ${msg.type} to ${online.length} agent(s)`);
      break;
    }

    case "reply":
      await apiClient.sendMessage(msg.threadId, {
        fromAgent: config.agentId,
        toAgent: msg.fromAgent,
        type: "reply",
        body: action.messageBody as string,
      });
      console.log(`[message-loop] Replied to ${msg.type} from ${msg.fromAgent}`);
      break;

    case "log_only":
    default:
      break;
  }
}

export async function handleMessage(
  msg: MessageRow,
  apiClient: OrchestratorApiClient,
  anthropic: Anthropic,
  config: OrchestratorConfig,
): Promise<void> {
  // Only handle messages addressed to the orchestrator or broadcast (toAgent null/undefined)
  if (msg.toAgent && msg.toAgent !== config.agentId) return;
  // Never react to our own messages
  if (msg.fromAgent === config.agentId) return;

  switch (msg.type) {
    case "status":
    case "reply":
      // No action — just acknowledge
      break;

    case "escalation": {
      console.warn(`\n[ESCALATION] from=${msg.fromAgent} thread=${msg.threadId}`);
      console.warn(`  ${msg.body}\n`);

      const allAgents = await apiClient.getWorkerAgents(config.projectId);
      const taskCounts = await apiClient.getActiveTaskCounts(config.projectId);
      const online = allAgents.filter((a) => isOnline(a.lastSeenAt));

      // Find the best senior agent: prefer tier-2, fall back to 'architect' specialization
      let seniors = online.filter((a) => a.tier === 2);
      if (seniors.length === 0) seniors = online.filter((a) => a.specialization === "architect");

      if (seniors.length === 0) {
        // No senior agent available — surface to human
        await apiClient.sendMessage(msg.threadId, {
          fromAgent: config.agentId,
          toAgent: msg.fromAgent,
          type: "reply",
          body: "Escalation received. No senior agent is currently available — surfaced to human operator.",
        });
        break;
      }

      // Pick the least busy senior
      const scored = seniors.map((a) => ({ agent: a, count: taskCounts[a.id] ?? 0 }));
      const min = Math.min(...scored.map((s) => s.count));
      const senior = scored.find((s) => s.count === min)!.agent;

      // Create a task for the senior, carrying the escalation context
      const task = await apiClient.createTask({
        projectId: config.projectId,
        createdBy: config.agentId,
        title: `Escalation from ${msg.fromAgent}`,
        description: msg.body,
        specialization: "architect",
        priority: "high",
        metadata: {
          sourceThread: msg.threadId,
          escalatedFrom: msg.fromAgent,
          escalationMessageId: msg.id,
          originalMetadata: msg.metadata,
        },
      });

      await apiClient.assignTask(task.id, senior.id);

      await apiClient.sendMessage(msg.threadId, {
        fromAgent: config.agentId,
        toAgent: msg.fromAgent,
        type: "reply",
        body: `Escalation received. Created task ${task.id} and assigned to senior agent ${senior.id} for follow-up.`,
      });

      console.log(`[message-loop] Escalation → task ${task.id} assigned to senior agent ${senior.id}`);
      break;
    }

    case "decision": {
      const agents = await apiClient.getWorkerAgents(config.projectId);
      const online = agents.filter((a) => isOnline(a.lastSeenAt));
      for (const agent of online) {
        await apiClient.sendMessage(msg.threadId, {
          fromAgent: config.agentId,
          toAgent: agent.id,
          type: "decision",
          body: msg.body,
          metadata: { broadcastFrom: msg.fromAgent, originalMessage: msg.id },
        });
      }
      if (online.length > 0) {
        console.log(`[message-loop] Broadcast decision to ${online.length} agent(s)`);
      }
      break;
    }

    case "handoff":
    case "question":
    case "finding": {
      try {
        const action = await claudeMessageRoute(msg, apiClient, anthropic, config);
        await executeAction(action, msg, apiClient, config);
      } catch (err) {
        console.error(`[message-loop] Claude routing failed for ${msg.type} message ${msg.id}:`, err);
      }
      break;
    }
  }

  await apiClient.markRead(msg.threadId, config.agentId);
}

export async function runMessageRoutingCycle(
  apiClient: OrchestratorApiClient,
  anthropic: Anthropic,
  config: OrchestratorConfig,
): Promise<void> {
  try {
    const messages = await apiClient.getUnreadMessages(config.agentId, config.projectId);
    if (messages.length > 0) {
      console.log(`[message-loop] ${messages.length} unread message(s) — processing`);
      for (const msg of messages) {
        await handleMessage(msg, apiClient, anthropic, config);
      }
    }
  } catch (err) {
    console.error("[message-loop] Message routing cycle error:", err);
  }
}
