import type { IncomingMessage, ServerResponse } from "node:http";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { isAuthorizedBearer } from "./http-auth.js";

type HttpRequestListener = (req: IncomingMessage, res: ServerResponse) => Promise<void>;

const UNAUTHORIZED_BODY = JSON.stringify({
  error: { code: "unauthorized", message: "Missing or invalid bearer token" },
});

// Builds the HTTP/SSE request listener, gated on the same credential this
// process was started with (MCP_HTTP_TOKEN, API_SECRET, or API_OWNER_TOKEN) —
// the only identity the HTTP transport has, since unlike stdio it can be
// reached by anyone who can open a TCP connection to it. An unauthenticated
// request never reaches server.connect() or the message handler.
export function createHttpRequestListener(server: McpServer, credential: string): HttpRequestListener {
  // The underlying McpServer supports exactly one live transport at a time.
  // A reconnect (a dropped network, a client restart) is the ordinary case
  // for this transport, so a new GET /sse takes over rather than being
  // refused: whatever connection it replaces is closed explicitly first, so
  // that connection's own eventual close can never race with — and null out
  // — the new one. This also means a peer that silently vanished (no FIN)
  // never locks the transport closed; the next reconnect simply displaces it.
  let current: SSEServerTransport | undefined;

  async function connectSse(res: ServerResponse): Promise<SSEServerTransport> {
    const transport = new SSEServerTransport("/messages", res);
    await server.connect(transport);
    return transport;
  }

  return async (req, res) => {
    if (!isAuthorizedBearer(req.headers.authorization, credential)) {
      console.error(`[relai-mcp] rejected unauthenticated HTTP request: ${req.method} ${req.url}`);
      res
        .writeHead(401, { "content-type": "application/json", "www-authenticate": "Bearer" })
        .end(UNAUTHORIZED_BODY);
      return;
    }

    // SSEServerTransport.start() advertises the endpoint clients must POST
    // to as "/messages?sessionId=<uuid>" — match on the path alone so that
    // real traffic (which always carries the query string) reaches the same
    // branch a bare "/messages" does, rather than falling through to 404.
    const path = (req.url ?? "").split("?")[0];

    if (req.method === "GET" && path === "/sse") {
      const replaced = current;
      current = undefined;
      if (replaced) {
        try {
          await replaced.close();
        } catch {
          // Already gone — that's exactly the case this takeover exists for.
        }
      }
      try {
        current = await connectSse(res);
      } catch (err) {
        console.error("[relai-mcp] failed to establish SSE connection:", err instanceof Error ? err.message : err);
        if (!res.headersSent) {
          res
            .writeHead(500, { "content-type": "application/json" })
            .end(JSON.stringify({ error: { code: "connect_failed", message: "Failed to establish SSE connection" } }));
        }
      }
    } else if (req.method === "POST" && path === "/messages") {
      res.writeHead(200).end();
    } else {
      res.writeHead(404).end();
    }
  };
}
