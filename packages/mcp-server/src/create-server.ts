import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

// capabilities.logging is required, not cosmetic: sendLoggingMessage() runs
// assertNotificationCapability first, so without it every notification throws.
// Both poll loops caught and discarded that, which is how it went unnoticed.
export function createMcpServer(name: string, version: string): McpServer {
  return new McpServer({ name, version }, { capabilities: { logging: {} } });
}
