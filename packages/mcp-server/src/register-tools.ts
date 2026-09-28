import { selectTools, type ToolConfig } from "./tools.js";
import { detectOwnerScope } from "./owner-scope.js";
import type { ApiClient } from "./api-client.js";

// Anything that can accept a tool. Narrow on purpose so this is testable with a
// spy: index.ts is an entrypoint with side effects, and the wiring that lives
// there is exactly what went untested and shipped the original defect.
export type ToolRegistrar = {
  tool: (name: string, description: string, shape: never, handler: never) => unknown;
};

export async function registerTools(
  server: ToolRegistrar,
  client: ApiClient,
  config: ToolConfig,
  detect: typeof detectOwnerScope = detectOwnerScope,
): Promise<string[]> {
  const resolved: ToolConfig = config.ownerMode
    ? config
    : { ...config, ownerScoped: await detect(client, config.agentId) };

  if (!resolved.ownerMode && resolved.ownerScoped) {
    console.error("[relai-mcp] credential is owner-scoped — provisioning tools registered");
  }

  const tools = selectTools(client, resolved);
  for (const tool of tools) {
    server.tool(
      tool.name,
      tool.description,
      tool.inputSchema.shape as never,
      tool.handler as never,
    );
  }
  return tools.map((t) => t.name);
}
