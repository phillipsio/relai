import { createServer, type Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMcpServer } from "./create-server.js";
import { createHttpRequestListener } from "./http-transport.js";

const CREDENTIAL = "test-credential-xyz";

async function startTestServer(): Promise<{ url: string; close: () => Promise<void> }> {
  const mcpServer = createMcpServer("test", "0.0.0");
  const listener = createHttpRequestListener(mcpServer, CREDENTIAL);
  const httpServer: Server = createServer(listener);
  await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  const address = httpServer.address();
  if (!address || typeof address === "string") throw new Error("expected a bound TCP address");
  return {
    url: `http://127.0.0.1:${address.port}`,
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

  it("pins the known POST /messages no-op (200, not yet wired to handlePostMessage — see AGENTS.md), including the ?sessionId= query string real clients send", async () => {
    const server = await startTestServer();
    close = server.close;
    const auth = { authorization: `Bearer ${CREDENTIAL}` };
    const bare = await fetch(`${server.url}/messages`, { method: "POST", headers: auth });
    expect(bare.status).toBe(200);
    const withSessionId = await fetch(`${server.url}/messages?sessionId=test-session-id`, {
      method: "POST",
      headers: auth,
    });
    expect(withSessionId.status).toBe(200);
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
});
