"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createHttpRequestListener = createHttpRequestListener;
const sse_js_1 = require("@modelcontextprotocol/sdk/server/sse.js");
const http_auth_js_1 = require("./http-auth.js");
const UNAUTHORIZED_BODY = JSON.stringify({
    error: { code: "unauthorized", message: "Missing or invalid bearer token" },
});
// Builds the HTTP/SSE request listener, gated on the same credential this
// process was started with (MCP_HTTP_TOKEN, API_SECRET, or API_OWNER_TOKEN) —
// the only identity the HTTP transport has, since unlike stdio it can be
// reached by anyone who can open a TCP connection to it. An unauthenticated
// request never reaches server.connect() or the message handler.
function createHttpRequestListener(server, credential) {
    // The underlying McpServer supports exactly one live transport at a time.
    // A reconnect (a dropped network, a client restart) is the ordinary case
    // for this transport, so a new GET /sse takes over rather than being
    // refused: whatever connection it replaces is closed explicitly first, so
    // that connection's own eventual close can never race with — and null out
    // — the new one. This also means a peer that silently vanished (no FIN)
    // never locks the transport closed; the next reconnect simply displaces it.
    let current;
    async function connectSse(res) {
        const transport = new sse_js_1.SSEServerTransport("/messages", res);
        await server.connect(transport);
        return transport;
    }
    return async (req, res) => {
        if (!(0, http_auth_js_1.isAuthorizedBearer)(req.headers.authorization, credential)) {
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
                }
                catch {
                    // Already gone — that's exactly the case this takeover exists for.
                }
            }
            try {
                current = await connectSse(res);
            }
            catch (err) {
                console.error("[relai-mcp] failed to establish SSE connection:", err instanceof Error ? err.message : err);
                if (!res.headersSent) {
                    res
                        .writeHead(500, { "content-type": "application/json" })
                        .end(JSON.stringify({ error: { code: "connect_failed", message: "Failed to establish SSE connection" } }));
                }
            }
        }
        else if (req.method === "POST" && path === "/messages") {
            res.writeHead(200).end();
        }
        else {
            res.writeHead(404).end();
        }
    };
}
//# sourceMappingURL=http-transport.js.map