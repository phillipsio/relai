import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

const TOKEN_PREFIX = "aio_";
const INVITE_PREFIX = "inv_";

export function generateToken(): string {
  return TOKEN_PREFIX + randomBytes(32).toString("base64url");
}

export function generateInviteCode(): string {
  return INVITE_PREFIX + randomBytes(24).toString("base64url");
}

export function hashSecret(plaintext: string): string {
  return createHash("sha256").update(plaintext).digest("hex");
}

// Back-compat alias — earlier slice referenced this name from the auth plugin.
export const hashToken = hashSecret;

export function looksLikeAgentToken(value: string): boolean {
  return value.startsWith(TOKEN_PREFIX);
}

// Compare a caller-supplied secret against a configured one without leaking a
// match position through timing. Hashing first gives both sides a fixed 32-byte
// length, so timingSafeEqual cannot throw on a size mismatch and the comparison
// reveals nothing about the expected secret's length either.
export function secretsMatch(provided: string, expected: string | undefined): boolean {
  if (!expected) return false;
  return timingSafeEqual(
    createHash("sha256").update(provided).digest(),
    createHash("sha256").update(expected).digest(),
  );
}
