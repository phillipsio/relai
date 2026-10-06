import { describe, expect, it } from "vitest";
import { isAuthorizedBearer } from "./http-auth.js";

const CREDENTIAL = "owner-token-abc123";

describe("isAuthorizedBearer", () => {
  it("rejects a missing Authorization header", () => {
    expect(isAuthorizedBearer(undefined, CREDENTIAL)).toBe(false);
  });

  it("rejects a header without the Bearer scheme", () => {
    expect(isAuthorizedBearer(CREDENTIAL, CREDENTIAL)).toBe(false);
    expect(isAuthorizedBearer(`Basic ${CREDENTIAL}`, CREDENTIAL)).toBe(false);
  });

  it("rejects the wrong token", () => {
    expect(isAuthorizedBearer("Bearer wrong-token", CREDENTIAL)).toBe(false);
  });

  it("rejects a token of a different length without throwing", () => {
    // timingSafeEqual throws on mismatched buffer lengths — the length check
    // must happen before it, not as an afterthought.
    expect(() => isAuthorizedBearer("Bearer short", CREDENTIAL)).not.toThrow();
    expect(isAuthorizedBearer("Bearer short", CREDENTIAL)).toBe(false);
  });

  it("rejects an empty token", () => {
    expect(isAuthorizedBearer("Bearer ", CREDENTIAL)).toBe(false);
  });

  it("accepts the correct bearer token", () => {
    expect(isAuthorizedBearer(`Bearer ${CREDENTIAL}`, CREDENTIAL)).toBe(true);
  });

  it("is case-sensitive on the token value", () => {
    expect(isAuthorizedBearer(`Bearer ${CREDENTIAL.toUpperCase()}`, CREDENTIAL)).toBe(false);
  });
});
