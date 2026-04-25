import type { AgentRow, TaskRow } from "../api-client.js";

export const ROUTER_SYSTEM_PROMPT = `You are an engineering project orchestrator. Your only job is to assign tasks to the right agent.

Rules:
- Assign each task to exactly one worker agent.
- Match task domains to agent domains. If a task has domains ["frontend", "auth"], prefer agents with those domains.
- If multiple agents could handle a task, prefer the one whose domain list is the closest match.
- Never assign to an agent whose lastSeenAt is more than 10 minutes ago — they may be offline.
- If no agent is a good fit and you cannot confidently assign, use agentId = "UNROUTABLE" and explain why.
- Be brief in your rationale — one sentence is enough.`;

export function buildRoutingMessage(task: TaskRow, agents: AgentRow[]): string {
  const agentList = agents
    .map((a) => {
      const age = Date.now() - new Date(a.lastSeenAt).getTime();
      const online = age < 10 * 60 * 1000;
      return `- id: ${a.id}  name: ${a.name}  domains: [${a.domains.join(", ")}]  online: ${online}`;
    })
    .join("\n");

  return `Task to assign:
  id: ${task.id}
  title: ${task.title}
  description: ${task.description}
  domains: [${task.domains.join(", ")}]
  priority: ${task.priority}

Available agents:
${agentList}

Use the route_task tool to assign this task.`;
}

// Tool definition sent to Claude — forces structured JSON output instead of free text.
export const ROUTING_TOOL = {
  name: "route_task",
  description: "Assign the task to an agent",
  input_schema: {
    type: "object" as const,
    properties: {
      agentId: {
        type: "string",
        description: "The ID of the agent to assign the task to, or UNROUTABLE if no agent fits.",
      },
      rationale: {
        type: "string",
        description: "One sentence explaining why this agent was chosen.",
      },
    },
    required: ["agentId", "rationale"],
  },
};
