import { describe, it, expect } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createMcpServer } from "./create-server.js";

// The notification path was dead for months because the capability was missing
// and both callers caught the resulting throw. This pins the capability rather
// than the symptom, since the symptom is silence.
describe("the server can actually send notifications", () => {
  it("declares the logging capability", () => {
    const s = createMcpServer("relai", "0.0.0") as unknown as {
      server: { _capabilities: Record<string, unknown> };
    };
    expect(s.server._capabilities.logging).toBeDefined();
  });

  it("passes the assertion sendLoggingMessage runs before sending", () => {
    const s = createMcpServer("relai", "0.0.0") as unknown as {
      server: { assertNotificationCapability: (m: string) => void };
    };
    expect(() => s.server.assertNotificationCapability("notifications/message")).not.toThrow();
  });

  // Proves the test above can fail: the bare constructor is what shipped.
  it("is exactly what a bare constructor does not give you", () => {
    const bare = new McpServer({ name: "relai", version: "0.0.0" }) as unknown as {
      server: { assertNotificationCapability: (m: string) => void };
    };
    expect(() => bare.server.assertNotificationCapability("notifications/message"))
      .toThrow(/does not support logging/);
  });

  it("keeps the name and version it was given", () => {
    const s = createMcpServer("relai-operator", "1.2.3") as unknown as {
      server: { _serverInfo: { name: string; version: string } };
    };
    expect(s.server._serverInfo).toMatchObject({ name: "relai-operator", version: "1.2.3" });
  });
});
