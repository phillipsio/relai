import Anthropic from "@anthropic-ai/sdk";
import type { AgentRow, TaskRow } from "../api-client.js";
import { ROUTER_SYSTEM_PROMPT, buildRoutingMessage, ROUTING_TOOL } from "../prompts/router.js";
import type { RoutingResult } from "./rules.js";

export async function claudeRouting(
  task: TaskRow,
  agents: AgentRow[],
  client: Anthropic,
  model: string
): Promise<RoutingResult> {
  const message = await client.messages.create({
    model,
    max_tokens: 256,   // routing decisions are short — cap spend
    system: ROUTER_SYSTEM_PROMPT,
    tools: [ROUTING_TOOL],
    tool_choice: { type: "any" },   // force tool use, no free-text response
    messages: [
      { role: "user", content: buildRoutingMessage(task, agents) },
    ],
  });

  // Extract the tool call result
  const toolUse = message.content.find((b) => b.type === "tool_use");
  if (!toolUse || toolUse.type !== "tool_use") {
    throw new Error("Claude did not return a routing decision");
  }

  const input = toolUse.input as { agentId: string; rationale: string };
  return {
    agentId: input.agentId,
    rationale: input.rationale,
    method: "claude",
  };
}
