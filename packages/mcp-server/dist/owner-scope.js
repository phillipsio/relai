"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.detectOwnerScope = detectOwnerScope;
// Tools are registered before the client connects, so this call sits on the
// startup path. A slow MCP startup is not a degraded connection, it is no
// connection: see the npx incident in AGENTS.md. Bound it well inside that
// window and treat every failure as "not owner-scoped".
const DEFAULT_TIMEOUT_MS = 2_000;
async function detectOwnerScope(client, agentId, timeoutMs = DEFAULT_TIMEOUT_MS) {
    let timer;
    try {
        const rows = await Promise.race([
            client.listAgentTokens(agentId),
            new Promise((_, reject) => {
                timer = setTimeout(() => reject(new Error(`timed out after ${timeoutMs}ms`)), timeoutMs);
            }),
        ]);
        if (!Array.isArray(rows))
            throw new Error("expected a list of tokens");
        // The row that authenticated THIS request, never a sibling: another token
        // carrying owner scope says nothing about the credential in hand.
        return rows.some((t) => t.current === true && t.ownerScoped === true);
    }
    catch (err) {
        // Never silent. A swallowed throw here looks exactly like an ordinary
        // repo-scoped startup, which is how the logging-capability bug survived.
        console.error(`[relai-mcp] could not resolve owner scope (${String(err)}) — starting with the standard agent toolset. ` +
            "If this agent should have the provisioning tools, restart it once the API is reachable.");
        return false;
    }
    finally {
        if (timer)
            clearTimeout(timer);
    }
}
//# sourceMappingURL=owner-scope.js.map