import { describe, it, expect } from "vitest";
import { z } from "zod";
import { createMcpServer } from "./create-server.js";

type ListToolsHandler = (
  req: { method: string; params: Record<string, never> },
  extra: { signal: AbortSignal },
) => Promise<{ tools: Array<Record<string, unknown>> }>;

function listTools(): Promise<{ tools: Array<Record<string, unknown>> }> {
  const server = createMcpServer("relai", "0.0.0") as unknown as {
    tool: (n: string, d: string, s: object, h: () => unknown) => void;
    server: { _requestHandlers: Map<string, ListToolsHandler> };
  };
  server.tool("demo", "a tool", { a: z.string() }, () => ({
    content: [{ type: "text", text: "ok" }],
  }));
  const handler = server.server._requestHandlers.get("tools/list");
  if (!handler) throw new Error("the SDK no longer registers a tools/list handler");
  return handler({ method: "tools/list", params: {} }, { signal: new AbortController().signal })
    // Round-trip through JSON so this sees what a client sees: an
    // undefined-valued key never reaches the wire and must not fail the test.
    .then((res) => JSON.parse(JSON.stringify(res)));
}

// SDK 1.24.0+ adds execution.taskSupport here, which Claude Code v2.x drops the
// whole tool over. Typecheck and the suite both stay green when that happens.
describe("what the SDK puts on the wire for a tool definition", () => {
  it("carries no key beyond name, description and inputSchema", async () => {
    const { tools } = await listTools();
    expect(tools).toHaveLength(1);
    expect(Object.keys(tools[0]).sort()).toEqual(["description", "inputSchema", "name"]);
  });

  it("does not announce task support", async () => {
    const { tools } = await listTools();
    expect(JSON.stringify(tools)).not.toContain("taskSupport");
  });
});
