import { createHash, timingSafeEqual } from "node:crypto";

function sha256(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

// `Boolean(" ")` is true, so a whitespace-only env var reads as "set" at
// every truthiness check upstream of here — this is the one place that
// actually means it.
export function isBlankCredential(value: string): boolean {
  return value.trim().length === 0;
}

// The HTTP/SSE transport has no per-request identity of its own — the
// credential is whatever this process was started with (MCP_HTTP_TOKEN,
// API_SECRET, or API_OWNER_TOKEN). Hashing both sides to a fixed 32-byte
// digest before comparing means timingSafeEqual never throws on a length
// mismatch and the comparison leaks nothing about either side's length,
// matching the pattern packages/api/src/lib/tokens.ts's secretsMatch() uses
// for the same kind of check. An empty or whitespace-only credential is
// refused outright rather than becoming an always-matching value: nothing
// upstream guarantees this string came from a non-empty env var.
export function isAuthorizedBearer(authHeader: string | undefined, credential: string): boolean {
  if (isBlankCredential(credential) || !authHeader) return false;

  const spaceIndex = authHeader.indexOf(" ");
  if (spaceIndex === -1) return false;
  if (authHeader.slice(0, spaceIndex).toLowerCase() !== "bearer") return false;

  const token = authHeader.slice(spaceIndex + 1);
  return timingSafeEqual(sha256(token), sha256(credential));
}

// Which value gates the HTTP transport. A pure function so the precedence
// (MCP_HTTP_TOKEN, when set, wins over the credential forwarded upstream) is
// unit-testable on its own, rather than living as inline logic in index.ts —
// AGENTS.md records that shape of bug once already (selectTools).
export function resolveHttpCredential(
  mcpHttpToken: string | undefined,
  ownerMode: boolean,
  ownerToken: string | undefined,
  apiSecret: string | undefined,
): string {
  if (mcpHttpToken) return mcpHttpToken;
  return (ownerMode ? ownerToken : apiSecret) ?? "";
}
