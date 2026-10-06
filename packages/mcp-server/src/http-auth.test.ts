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

  it("accepts a lowercase or mixed-case scheme name, per RFC 7235", () => {
    expect(isAuthorizedBearer(`bearer ${CREDENTIAL}`, CREDENTIAL)).toBe(true);
    expect(isAuthorizedBearer(`BEARER ${CREDENTIAL}`, CREDENTIAL)).toBe(true);
  });

  it("rejects the wrong token", () => {
    expect(isAuthorizedBearer("Bearer wrong-token", CREDENTIAL)).toBe(false);
  });

  it("rejects a token of a different length without throwing", () => {
    expect(() => isAuthorizedBearer("Bearer short", CREDENTIAL)).not.toThrow();
    expect(isAuthorizedBearer("Bearer short", CREDENTIAL)).toBe(false);
  });

  it("rejects an empty token against a real credential", () => {
    expect(isAuthorizedBearer("Bearer ", CREDENTIAL)).toBe(false);
  });

  it("never authorizes when the configured credential is empty or whitespace, however it's probed", () => {
    expect(isAuthorizedBearer("Bearer ", "")).toBe(false);
    expect(isAuthorizedBearer("Bearer  ", " ")).toBe(false);
    expect(isAuthorizedBearer("Bearer x", "")).toBe(false);
  });

  it("accepts the correct bearer token", () => {
    expect(isAuthorizedBearer(`Bearer ${CREDENTIAL}`, CREDENTIAL)).toBe(true);
  });

  it("is case-sensitive on the token value itself, unlike the scheme name", () => {
    expect(isAuthorizedBearer(`Bearer ${CREDENTIAL.toUpperCase()}`, CREDENTIAL)).toBe(false);
  });
});
