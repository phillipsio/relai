// Prompt + tool schema used by the in-API message loop when classifying
// handoff/question/finding messages with Claude. Ported from the standalone
// orchestrator daemon. Kept verbatim where possible so the routing behaviour
// is the same as the historical daemon.

interface PromptAgent {
  id: string;
  name: string;
  specialization?: string | null;
  domains: string[];
  lastSeenAt: string | Date;
}

interface PromptMessage {
  type: string;
  fromAgent: string;
  body: string;
  metadata: Record<string, unknown>;
}

export const MESSAGE_ROUTER_SYSTEM_PROMPT = `You are an engineering project orchestrator deciding how to handle an incoming agent message.

Rules:
- handoff: the sender finished work and is handing off. Extract a concrete task from the body and return create_task. If the body clearly targets a specific agent, return forward instead.
- question: the sender is blocked. If you can answer clearly from the message body, return reply. If a specialist agent is better suited, return forward.
- finding: a discovery that may affect other work. Return create_task if it implies new work, or broadcast if other agents just need to know.
- Always be specific — the body field you write will be the only context the receiver has.
- Prefer create_task over forward for handoffs — tasks flow through the routing pipeline automatically.
- Never assign UNROUTABLE — always choose the best available option.
- Be brief in messageBody and taskDescription — one to three sentences.`;

export function buildMessageRoutingContext(msg: PromptMessage, agents: PromptAgent[]): string {
  const now = Date.now();
  const agentList = agents
    .map((a) => {
      const online = now - new Date(a.lastSeenAt).getTime() < 10 * 60 * 1000;
      return `- id: ${a.id}  name: ${a.name}  specialization: ${a.specialization ?? "none"}  domains: [${a.domains.join(", ")}]  online: ${online}`;
    })
    .join("\n");

  return `Incoming message:
  type: ${msg.type}
  from: ${msg.fromAgent}
  body: ${msg.body}
  metadata: ${JSON.stringify(msg.metadata)}

Available agents:
${agentList || "  (none online)"}

Use the route_message tool to decide how to handle this message.`;
}

export const MESSAGE_ROUTING_TOOL = {
  name: "route_message",
  description: "Decide how to handle this incoming agent message",
  input_schema: {
    type: "object" as const,
    properties: {
      action: {
        type: "string",
        enum: ["create_task", "forward", "broadcast", "reply", "log_only"],
        description: "create_task: extract work into a new task. forward: send to a specific agent. broadcast: send to all online agents. reply: respond on this thread. log_only: no action needed.",
      },
      taskTitle:          { type: "string", description: "Required for create_task." },
      taskDescription:    { type: "string", description: "Required for create_task." },
      taskDomains:        { type: "array", items: { type: "string" }, description: "Required for create_task." },
      taskSpecialization: { type: "string", description: "Optional hint for create_task routing." },
      taskPriority: {
        type: "string",
        enum: ["low", "normal", "high", "urgent"],
        description: "Required for create_task.",
      },
      toAgent:     { type: "string", description: "Required for forward: the agent ID to send to." },
      messageBody: { type: "string", description: "Required for forward, broadcast, and reply." },
    },
    required: ["action"],
  },
};
