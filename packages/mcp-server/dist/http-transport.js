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
    // McpServer.connect() replaces the server's single transport without
    // closing the one it replaces, so a second concurrent GET /sse doesn't
    // just "displace" the first connection — it silently kills a stream a
    // legitimate client still has open. Refuse the second connection loudly
    // instead, and allow a new one once the first actually disconnects.
    let connected = false;
    return async (req, res) => {
        if (!(0, http_auth_js_1.isAuthorizedBearer)(req.headers.authorization, credential)) {
            console.error(`[relai-mcp] rejected unauthenticated HTTP request: ${req.method} ${req.url}`);
            res
                .writeHead(401, { "content-type": "application/json", "www-authenticate": "Bearer" })
                .end(UNAUTHORIZED_BODY);
            return;
        }
        if (req.method === "GET" && req.url === "/sse") {
            if (connected) {
                res
                    .writeHead(409, { "content-type": "application/json" })
                    .end(JSON.stringify({ error: { code: "already_connected", message: "Another SSE client is already connected" } }));
                return;
            }
            connected = true;
            res.on("close", () => { connected = false; });
            const transport = new sse_js_1.SSEServerTransport("/messages", res);
            await server.connect(transport);
        }
        else if (req.method === "POST" && req.url === "/messages") {
            res.writeHead(200).end();
        }
        else {
            res.writeHead(404).end();
        }
    };
}
//# sourceMappingURL=http-transport.js.map