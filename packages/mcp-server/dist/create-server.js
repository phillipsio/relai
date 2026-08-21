"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createMcpServer = createMcpServer;
const mcp_js_1 = require("@modelcontextprotocol/sdk/server/mcp.js");
// capabilities.logging is required, not cosmetic: sendLoggingMessage() runs
// assertNotificationCapability first, so without it every notification throws.
// Both poll loops caught and discarded that, which is how it went unnoticed.
function createMcpServer(name, version) {
    return new mcp_js_1.McpServer({ name, version }, { capabilities: { logging: {} } });
}
//# sourceMappingURL=create-server.js.map