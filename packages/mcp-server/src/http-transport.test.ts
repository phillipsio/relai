import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { createMcpServer } from "./create-server.js";
import { createHttpRequestListener } from "./http-transport.js";

const CREDENTIAL = "test-credential-xyz";

async function startTestServer(): Promise<{ url: string; close: () => Promise<void> }> {
  const mcpServer = createMcpServer("test", "0.0.0");
  const listener = await createHttpRequestListener(mcpServer, CREDENTIAL);
  const httpServer: Server = createServer(listener);
  await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  const address = httpServer.address();
  if (!address || typeof address === "string") throw new Error("expected a bound TCP address");
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve, reject) => httpServer.close((err) => (err ? reject(err) : resolve()))),
  };
}

describe("HTTP/SSE transport auth gate", () => {
  let close: (() => Promise<void>) | undefined;

  afterEach(async () => {
    await close?.();
    close = undefined;
  });

  it("rejects GET /sse with no Authorization header", async () => {
    const server = await startTestServer();
    close = server.close;
    const res = await fetch(`${server.url}/sse`);
    expect(res.status).toBe(401);
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

  it("lets an authorized GET /sse past the gate and establish the SSE stream", async () => {
    const server = await startTestServer();
    close = server.close;
    const res = await fetch(`${server.url}/sse`, { headers: { authorization: `Bearer ${CREDENTIAL}` } });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/event-stream/);
    await res.body?.cancel();
  });
});
