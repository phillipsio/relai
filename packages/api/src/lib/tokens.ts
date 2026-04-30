import { createHash, randomBytes } from "node:crypto";

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
