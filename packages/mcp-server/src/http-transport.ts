import type { IncomingMessage, ServerResponse } from "node:http";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { isAuthorizedBearer } from "./http-auth.js";

export type HttpRequestListener = (req: IncomingMessage, res: ServerResponse) => Promise<void>;

// Builds the HTTP/SSE request listener gated on the same credential this
// process was started with (API_SECRET or API_OWNER_TOKEN) — the only
// identity the HTTP transport has, since unlike stdio it can be reached by
// anyone who can open a TCP connection to it. An unauthenticated request
// never reaches server.connect() or the message handler.
//
// SSEServerTransport is imported lazily (once, here, not per request) so
// stdio-only installs don't pay for the HTTP deps.
export async function createHttpRequestListener(
  server: McpServer,
  credential: string,
): Promise<HttpRequestListener> {
  const { SSEServerTransport } = await import("@modelcontextprotocol/sdk/server/sse.js");

  return async (req, res) => {
    if (!isAuthorizedBearer(req.headers.authorization, credential)) {
      res.writeHead(401, { "content-type": "application/json" }).end(JSON.stringify({ error: "unauthorized" }));
      return;
    }
    if (req.method === "GET" && req.url === "/sse") {
      const transport = new SSEServerTransport("/messages", res);
      await server.connect(transport);
    } else if (req.method === "POST" && req.url === "/messages") {
      res.writeHead(200).end();
    } else {
      res.writeHead(404).end();
    }
  };
}
