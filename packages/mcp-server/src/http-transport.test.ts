import { createServer, type Server } from "node:http";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMcpServer } from "./create-server.js";
import { createHttpRequestListener } from "./http-transport.js";

const CREDENTIAL = "test-credential-xyz";

async function startTestServer(
  mcpServer: McpServer = createMcpServer("test", "0.0.0"),
): Promise<{ url: string; mcpServer: McpServer; close: () => Promise<void> }> {
  const listener = createHttpRequestListener(mcpServer, CREDENTIAL);
  const httpServer: Server = createServer(listener);
  await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  const address = httpServer.address();
  if (!address || typeof address === "string") throw new Error("expected a bound TCP address");
  return {
    url: `http://127.0.0.1:${address.port}`,
    mcpServer,
    close: () => {
      // Without this, a kept-alive idle socket makes httpServer.close()'s
      // callback wait out Node's default 5s keepAliveTimeout before firing.
      httpServer.closeAllConnections();
      return new Promise<void>((resolve, reject) => httpServer.close((err) => (err ? reject(err) : resolve())));
    },
  };
}

async function readToEnd(body: ReadableStream<Uint8Array> | null): Promise<void> {
  const reader = body!.getReader();
  let done = false;
  while (!done) {
    ({ done } = await reader.read());
  }
}

// Resolves true if the stream reaches its end within timeoutMs, false if it
// times out first. Either way, the reader is cancelled on the way out, so a
// still-open stream doesn't leak past the test that opened it.
async function endsWithin(body: ReadableStream<Uint8Array> | null, timeoutMs: number): Promise<boolean> {
  const reader = body!.getReader();
  const deadline = Date.now() + timeoutMs;
  try {
    while (Date.now() < deadline) {
      const timeout = new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), deadline - Date.now()));
      const result = await Promise.race([reader.read(), timeout]);
      if (result === "timeout") return false;
      if (result.done) return true;
    }
    return false;
  } finally {
    await reader.cancel().catch(() => {});
  }
}

describe("HTTP/SSE transport auth gate", () => {
  let close: (() => Promise<void>) | undefined;

  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(async () => {
    await close?.();
    close = undefined;
    vi.restoreAllMocks();
  });

  it("rejects GET /sse with no Authorization header", async () => {
    const server = await startTestServer();
    close = server.close;
    const res = await fetch(`${server.url}/sse`);
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBe("Bearer");
  });

  it("rejects GET /sse with the wrong bearer token", async () => {
    const server = await startTestServer();
    close = server.close;
    const res = await fetch(`${server.url}/sse`, { headers: { authorization: "Bearer nope" } });
    expect(res.status).toBe(401);
  });

  it("rejects POST /messages with no Authorization header", async () => {
    const server = await startTestServer();
    close = server.close;
    const res = await fetch(`${server.url}/messages`, { method: "POST" });
    expect(res.status).toBe(401);
  });

  it("rejects an unknown path with no Authorization header the same way as a known one", async () => {
    const server = await startTestServer();
    close = server.close;
    const res = await fetch(`${server.url}/whatever`);
    expect(res.status).toBe(401);
  });

  it("returns 404 for an unknown path once authorized", async () => {
    const server = await startTestServer();
    close = server.close;
    const res = await fetch(`${server.url}/whatever`, { headers: { authorization: `Bearer ${CREDENTIAL}` } });
    expect(res.status).toBe(404);
  });

  it("returns 404 for a known path with the wrong method, once authorized", async () => {
    const server = await startTestServer();
    close = server.close;
    const auth = { authorization: `Bearer ${CREDENTIAL}` };
    const postSse = await fetch(`${server.url}/sse`, { method: "POST", headers: auth });
    expect(postSse.status).toBe(404);
    const getMessages = await fetch(`${server.url}/messages`, { headers: auth });
    expect(getMessages.status).toBe(404);
  });

  it("pins the known POST /messages gap as a fast 501, not a silent 200 (see AGENTS.md), including the ?sessionId= query string real clients send", async () => {
    const server = await startTestServer();
    close = server.close;
    const auth = { authorization: `Bearer ${CREDENTIAL}` };
    const bare = await fetch(`${server.url}/messages`, { method: "POST", headers: auth });
    expect(bare.status).toBe(501);
    const withSessionId = await fetch(`${server.url}/messages?sessionId=test-session-id`, {
      method: "POST",
      headers: auth,
    });
    expect(withSessionId.status).toBe(501);
    const body = (await withSessionId.json()) as { error: { code: string } };
    expect(body.error.code).toBe("not_implemented");
  });

  it("lets an authorized GET /sse past the gate and establish the SSE stream", async () => {
    const server = await startTestServer();
    close = server.close;
    const res = await fetch(`${server.url}/sse`, { headers: { authorization: `Bearer ${CREDENTIAL}` } });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/event-stream/);
    await res.body?.cancel();
  });

  it("a new GET /sse takes over from a still-live one, ending the previous stream rather than refusing or silently corrupting it", async () => {
    const server = await startTestServer();
    close = server.close;
    const auth = { authorization: `Bearer ${CREDENTIAL}` };

    const first = await fetch(`${server.url}/sse`, { headers: auth });
    expect(first.status).toBe(200);

    // The first connection is never closed client-side here — this is the
    // regression case for a peer that vanished without a clean disconnect.
    const second = await fetch(`${server.url}/sse`, { headers: auth });
    expect(second.status).toBe(200);

    await readToEnd(first.body);
    await second.body?.cancel();
  });

  it("also takes over cleanly when the previous connection already closed", async () => {
    const server = await startTestServer();
    close = server.close;
    const auth = { authorization: `Bearer ${CREDENTIAL}` };

    const first = await fetch(`${server.url}/sse`, { headers: auth });
    expect(first.status).toBe(200);
    await first.body?.cancel();

    const second = await fetch(`${server.url}/sse`, { headers: auth });
    expect(second.status).toBe(200);
    await second.body?.cancel();
  });

  it("serializes two genuinely concurrent GET /sse requests rather than letting them race", async () => {
    const server = await startTestServer();
    close = server.close;
    const auth = { authorization: `Bearer ${CREDENTIAL}` };

    const [a, b] = await Promise.all([
      fetch(`${server.url}/sse`, { headers: auth }),
      fetch(`${server.url}/sse`, { headers: auth }),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);

    const [aEnded, bEnded] = await Promise.all([endsWithin(a.body, 300), endsWithin(b.body, 300)]);
    // Serialized takeover means exactly one of the two was displaced by the
    // other's connect — never both left open, never both closed.
    expect(aEnded).not.toBe(bEnded);

    const third = await fetch(`${server.url}/sse`, { headers: auth });
    expect(third.status).toBe(200);
    await third.body?.cancel();
  });

  it("a late close event from the replaced transport does not clear the new one's registration", async () => {
    const mcpServer = createMcpServer("test", "0.0.0");
    const connectedTransports: Array<{ onclose?: () => void }> = [];
    const realConnect = mcpServer.connect.bind(mcpServer);
    vi.spyOn(mcpServer, "connect").mockImplementation(async (transport: any) => {
      connectedTransports.push(transport);
      return realConnect(transport);
    });

    const server = await startTestServer(mcpServer);
    close = server.close;
    const auth = { authorization: `Bearer ${CREDENTIAL}` };

    const first = await fetch(`${server.url}/sse`, { headers: auth });
    expect(first.status).toBe(200);
    const second = await fetch(`${server.url}/sse`, { headers: auth });
    expect(second.status).toBe(200);

    expect(connectedTransports).toHaveLength(2);
    const [replaced] = connectedTransports;

    // Simulate the replaced connection's own socket finally closing after
    // the takeover already completed — a delayed FIN/RST is the ordinary
    // case for a make-before-break reconnect, not an edge case.
    replaced.onclose?.();

    // If that late close had wrongly cleared the live (second) transport's
    // registration, this would throw "Not connected".
    await expect(
      (mcpServer as unknown as { server: { sendLoggingMessage: (m: unknown) => Promise<void> } }).server.sendLoggingMessage(
        { level: "info", data: "still alive" },
      ),
    ).resolves.not.toThrow();

    await readToEnd(first.body);
    await second.body?.cancel();
  });

  it("responds 500 when server.connect() fails, detaches the failed transport, and leaves the transport usable for the next attempt", async () => {
    const mcpServer = createMcpServer("test", "0.0.0");
    let failedTransport: { onclose?: () => void } | undefined;
    const connectSpy = vi.spyOn(mcpServer, "connect").mockImplementationOnce(async (transport: any) => {
      failedTransport = transport;
      throw new Error("boom");
    });
    const server = await startTestServer(mcpServer);
    close = server.close;
    const auth = { authorization: `Bearer ${CREDENTIAL}` };

    const failed = await fetch(`${server.url}/sse`, { headers: auth });
    expect(failed.status).toBe(500);
    const body = (await failed.json()) as { error: { code: string } };
    expect(body.error.code).toBe("connect_failed");
    // Connect() wires its callbacks before awaiting start(), so a rejected
    // connect() is the same stray-callback hazard a replaced live transport
    // is — a failed attempt must come away detached too, not just discarded.
    expect(failedTransport?.onclose).toBeUndefined();

    connectSpy.mockRestore();
    const recovered = await fetch(`${server.url}/sse`, { headers: auth });
    expect(recovered.status).toBe(200);
    await recovered.body?.cancel();
  });

  it("serializes GET /sse through one takeover at a time, even when connect() is slow", async () => {
    const mcpServer = createMcpServer("test", "0.0.0");
    let connectCount = 0;
    let releaseFirst: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const realConnect = mcpServer.connect.bind(mcpServer);
    vi.spyOn(mcpServer, "connect").mockImplementation(async (transport: any) => {
      connectCount++;
      if (connectCount === 1) await gate;
      return realConnect(transport);
    });

    const server = await startTestServer(mcpServer);
    close = server.close;
    const auth = { authorization: `Bearer ${CREDENTIAL}` };

    const firstPromise = fetch(`${server.url}/sse`, { headers: auth });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(connectCount).toBe(1);

    // If GET /sse weren't serialized, this second request would start its
    // own takeover immediately and call connect() a second time right away,
    // without waiting for the first (still gated) connect() to resolve.
    const secondPromise = fetch(`${server.url}/sse`, { headers: auth });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(connectCount).toBe(1);

    releaseFirst?.();
    const [first, second] = await Promise.all([firstPromise, secondPromise]);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(connectCount).toBe(2);

    await readToEnd(first.body);
    await second.body?.cancel();
  });
});
