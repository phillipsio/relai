import type { ApiClient } from "./api-client.js";

// Tools are registered before the client connects, so this call sits on the
// startup path. A slow MCP startup is not a degraded connection, it is no
// connection: see the npx incident in AGENTS.md. Bound it well inside that
// window and treat every failure as "not owner-scoped".
const DEFAULT_TIMEOUT_MS = 2_000;

type TokenRow = { ownerScoped?: boolean; current?: boolean | null };

export async function detectOwnerScope(
  client: ApiClient,
  agentId: string,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const rows = await Promise.race([
      client.listAgentTokens(agentId),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`timed out after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
    if (!Array.isArray(rows)) throw new Error("expected a list of tokens");
    // The row that authenticated THIS request, never a sibling: another token
    // carrying owner scope says nothing about the credential in hand.
    return (rows as TokenRow[]).some((t) => t.current === true && t.ownerScoped === true);
  } catch (err) {
    // Never silent. A swallowed throw here looks exactly like an ordinary
    // repo-scoped startup, which is how the logging-capability bug survived.
    console.error(
      `[relai-mcp] could not resolve owner scope (${String(err)}) — starting with the standard agent toolset. ` +
      "If this agent should have the provisioning tools, restart it once the API is reachable.",
    );
    return false;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
