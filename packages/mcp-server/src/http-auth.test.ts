import { describe, expect, it } from "vitest";
import { isAuthorizedBearer, isBlankCredential, resolveHttpCredential } from "./http-auth.js";

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

  it("authorizes a non-ASCII credential consistently", () => {
    const utf8Credential = "pässwort-ünïcode";
    expect(isAuthorizedBearer(`Bearer ${utf8Credential}`, utf8Credential)).toBe(true);
    expect(isAuthorizedBearer(`Bearer wrong`, utf8Credential)).toBe(false);
  });
});

describe("resolveHttpCredential", () => {
  it("prefers MCP_HTTP_TOKEN when set, in either mode", () => {
    expect(resolveHttpCredential("transport-token", true, "owner-token", undefined)).toBe("transport-token");
    expect(resolveHttpCredential("transport-token", false, undefined, "api-secret")).toBe("transport-token");
  });

  it("falls back to the owner credential in owner mode when unset", () => {
    expect(resolveHttpCredential(undefined, true, "owner-token", undefined)).toBe("owner-token");
  });

  it("falls back to the agent credential outside owner mode when unset", () => {
    expect(resolveHttpCredential(undefined, false, undefined, "api-secret")).toBe("api-secret");
  });

  it("treats an empty MCP_HTTP_TOKEN as unset, not as a real value", () => {
    expect(resolveHttpCredential("", true, "owner-token", undefined)).toBe("owner-token");
    expect(resolveHttpCredential("", false, undefined, "api-secret")).toBe("api-secret");
  });
});

describe("isBlankCredential", () => {
  it("treats an empty string as blank", () => {
    expect(isBlankCredential("")).toBe(true);
  });

  it("treats a whitespace-only string as blank", () => {
    expect(isBlankCredential(" ")).toBe(true);
    expect(isBlankCredential("\t\n ")).toBe(true);
  });

  it("treats any non-whitespace content as not blank", () => {
    expect(isBlankCredential("x")).toBe(false);
    expect(isBlankCredential("  x  ")).toBe(false);
  });
});
