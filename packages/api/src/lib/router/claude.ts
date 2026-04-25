import Anthropic from "@anthropic-ai/sdk";
import type { AgentRow, TaskRow, RoutingResult } from "./rules.js";

const SYSTEM_PROMPT = `You are an engineering project orchestrator. Your only job is to assign tasks to the right agent.

Rules:
- Assign each task to exactly one worker agent.
- Match task domains to agent domains. If a task has domains ["frontend", "auth"], prefer agents with those domains.
- If multiple agents could handle a task, prefer the one whose domain list is the closest match.
- Never assign to an agent whose lastSeenAt is more than 10 minutes ago — they may be offline.
- If no agent is a good fit, use agentId = "UNROUTABLE" and explain why.
- Be brief in your rationale — one sentence is enough.`;

const ROUTING_TOOL = {
  name: "route_task",
  description: "Assign the task to an agent",
  input_schema: {
    type: "object" as const,
    properties: {
      agentId: { type: "string", description: "The agent ID to assign to, or UNROUTABLE." },
      rationale: { type: "string", description: "One sentence explaining the choice." },
    },
    required: ["agentId", "rationale"],
  },
};

function buildMessage(task: TaskRow, agents: AgentRow[]): string {
  const agentList = agents.map((a) => {
    const age = Date.now() - new Date(a.lastSeenAt).getTime();
    const online = age < 10 * 60 * 1000;
    return `- id: ${a.id}  name: ${a.name}  specialization: ${a.specialization ?? "none"}  domains: [${a.domains.join(", ")}]  online: ${online}`;
  }).join("\n");


  return `Task to assign:
  id: ${task.id}
  title: ${task.title}
  description: ${task.description}
  domains: [${task.domains.join(", ")}]
  specialization: ${task.specialization ?? "none"}
  priority: ${task.priority}

Available agents:
${agentList}

Use the route_task tool to assign this task.`;
}

export async function claudeRouting(
  task: TaskRow,
  agents: AgentRow[],
  client: Anthropic,
  model: string,
): Promise<RoutingResult> {
  const message = await client.messages.create({
    model,
    max_tokens: 256,
    system: SYSTEM_PROMPT,
    tools: [ROUTING_TOOL],
    tool_choice: { type: "any" },
    messages: [{ role: "user", content: buildMessage(task, agents) }],
  });

  const toolUse = message.content.find((b: { type: string }) => b.type === "tool_use");
  if (!toolUse || toolUse.type !== "tool_use") {
    throw new Error("Claude did not return a routing decision");
  }

  const input = toolUse.input as { agentId: string; rationale: string };
  return { agentId: input.agentId, rationale: input.rationale, method: "claude" };
}
