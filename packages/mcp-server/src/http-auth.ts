import { timingSafeEqual } from "node:crypto";

// The HTTP/SSE transport has no per-request identity of its own — the
// credential is whatever this process was started with (API_SECRET or
// API_OWNER_TOKEN), the same one forwarded to the API on every call. So a
// connecting client proves it holds that same value via a bearer header,
// compared in constant time to avoid leaking the credential one byte at a
// time through response latency.
export function isAuthorizedBearer(authHeader: string | undefined, credential: string): boolean {
  const prefix = "Bearer ";
  if (!authHeader || !authHeader.startsWith(prefix)) return false;

  const token = Buffer.from(authHeader.slice(prefix.length));
  const expected = Buffer.from(credential);
  if (token.length !== expected.length) return false;
  return timingSafeEqual(token, expected);
}
