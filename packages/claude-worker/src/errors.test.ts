import { describe, it, expect } from "vitest";
import { isFatalError } from "./errors.js";

describe("isFatalError", () => {
  it("flags credit-exhaustion as fatal", () => {
    expect(isFatalError("Credit balance is too low")).toBe(true);
    expect(isFatalError("claude exited with code 1: Credit balance is too low")).toBe(true);
    expect(isFatalError("Error: insufficient_credits")).toBe(true);
  });

  it("flags auth/credential failures as fatal", () => {
    expect(isFatalError('{"type":"authentication_error","message":"invalid x-api-key"}')).toBe(true);
    expect(isFatalError("API Error: invalid api key")).toBe(true);
    expect(isFatalError("401 Unauthorized")).toBe(true);
    expect(isFatalError("OAuth token has expired. Please run /login")).toBe(true);
  });

  it("does NOT flag transient errors (rate limit, overload, network) as fatal", () => {
    expect(isFatalError('{"type":"rate_limit_error","message":"429"}')).toBe(false);
    expect(isFatalError('{"type":"overloaded_error"}')).toBe(false);
    expect(isFatalError("fetch failed: ECONNREFUSED 127.0.0.1:3010")).toBe(false);
    expect(isFatalError("claude exited with code 1: ")).toBe(false);
    expect(isFatalError("")).toBe(false);
  });

  it("is case-insensitive", () => {
    expect(isFatalError("CREDIT BALANCE IS TOO LOW")).toBe(true);
    expect(isFatalError("authentication_ERROR")).toBe(true);
  });
});
