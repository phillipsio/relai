"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createHttpRequestListener = createHttpRequestListener;
const sse_js_1 = require("@modelcontextprotocol/sdk/server/sse.js");
const http_auth_js_1 = require("./http-auth.js");
const UNAUTHORIZED_BODY = JSON.stringify({
    error: { code: "unauthorized", message: "Missing or invalid bearer token" },
});
const NOT_IMPLEMENTED_BODY = JSON.stringify({
    error: { code: "not_implemented", message: "This server does not yet process incoming tool-call messages" },
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
    // Two genuinely concurrent GET /sse requests each await across this whole
    // sequence, so without serializing them here both could read `current` as
    // stale and race to write it last — chaining every attempt through one
    // promise makes "close the old one, connect the new one" atomic relative
    // to any other connection attempt, not just relative to a single `await`.
    let takeoverQueue = Promise.resolve();
    async function connectSse(res) {
        const transport = new sse_js_1.SSEServerTransport("/messages", res);
        await server.connect(transport);
        return transport;
    }
    async function takeOver(res) {
        const replaced = current;
        current = undefined;
        if (replaced) {
            // close() ends the old response but does not detach the callbacks
            // start() wired to it. Left wired, the old socket's own close event —
            // which can arrive well after this call returns, since Node doesn't
            // tear down a response's connection synchronously with end() — fires
            // Protocol's shared _onclose and clears whatever transport is current
            // by then, including the new one this takeover is about to connect.
            // Detaching first means a late close from the replaced transport is a
            // no-op instead of a silent, delayed kill of its successor.
            replaced.onclose = undefined;
            replaced.onerror = undefined;
            replaced.onmessage = undefined;
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
            takeoverQueue = takeoverQueue.then(() => takeOver(res));
            await takeoverQueue;
        }
        else if (req.method === "POST" && path === "/messages") {
            // Not yet wired to handlePostMessage (see AGENTS.md). A bare 200 here
            // used to mean a real client's initialize request succeeded over the
            // wire and then hung for a minute waiting on a reply that never
            // comes — 501 fails it immediately and says why.
            res.writeHead(501, { "content-type": "application/json" }).end(NOT_IMPLEMENTED_BODY);
        }
        else {
            res.writeHead(404).end();
        }
    };
}
//# sourceMappingURL=http-transport.js.map