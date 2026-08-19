import { describe, it, expect } from "vitest";
import { classifySessionError } from "./errors.js";

describe("classifySessionError", () => {
  it("flags credit-exhaustion as a credentials failure", () => {
    expect(classifySessionError("Credit balance is too low")).toBe("credentials");
    expect(classifySessionError("claude exited with code 1: Credit balance is too low")).toBe("credentials");
    expect(classifySessionError("Error: insufficient_credits")).toBe("credentials");
  });

  it("flags auth/credential failures as a credentials failure", () => {
    expect(classifySessionError('{"type":"authentication_error","message":"invalid x-api-key"}')).toBe("credentials");
    expect(classifySessionError("API Error: invalid api key")).toBe("credentials");
    expect(classifySessionError("401 Unauthorized")).toBe("credentials");
    expect(classifySessionError("OAuth token has expired. Please run /login")).toBe("credentials");
  });

  it("flags context overflow as its own class, not transient", () => {
    expect(classifySessionError("Prompt is too long")).toBe("overflow");
    expect(classifySessionError("claude exited with code 1: prompt is too long: 213539 tokens > 200000")).toBe("overflow");
    expect(classifySessionError("input is too long for requested model")).toBe("overflow");
    expect(classifySessionError('{"type":"invalid_request_error","code":"context_window_exceeded"}')).toBe("overflow");
    expect(classifySessionError("413 request too large for this upstream")).toBe("overflow");
  });

  it("treats rate limit, overload and network blips as transient", () => {
    expect(classifySessionError('{"type":"rate_limit_error","message":"429"}')).toBe("transient");
    expect(classifySessionError('{"type":"overloaded_error"}')).toBe("transient");
    expect(classifySessionError("fetch failed: ECONNREFUSED 127.0.0.1:3010")).toBe("transient");
    expect(classifySessionError("claude exited with code 1: ")).toBe("transient");
    expect(classifySessionError("")).toBe("transient");
  });

  it("is case-insensitive", () => {
    expect(classifySessionError("CREDIT BALANCE IS TOO LOW")).toBe("credentials");
    expect(classifySessionError("authentication_ERROR")).toBe("credentials");
    expect(classifySessionError("PROMPT IS TOO LONG")).toBe("overflow");
  });

  // A bad credential breaks every task, so it outranks a per-task size problem.
  it("prefers credentials when a text matches both classes", () => {
    expect(classifySessionError("401 Unauthorized; prompt is too long")).toBe("credentials");
  });
});
