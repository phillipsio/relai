"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerTools = registerTools;
const tools_js_1 = require("./tools.js");
const owner_scope_js_1 = require("./owner-scope.js");
async function registerTools(server, client, config, detect = owner_scope_js_1.detectOwnerScope) {
    const resolved = config.ownerMode
        ? config
        : { ...config, ownerScoped: await detect(client, config.agentId) };
    if (!resolved.ownerMode && resolved.ownerScoped) {
        console.error("[relai-mcp] credential is owner-scoped — provisioning tools registered");
    }
    const tools = (0, tools_js_1.selectTools)(client, resolved);
    for (const tool of tools) {
        server.tool(tool.name, tool.description, tool.inputSchema.shape, tool.handler);
    }
    return tools.map((t) => t.name);
}
//# sourceMappingURL=register-tools.js.map