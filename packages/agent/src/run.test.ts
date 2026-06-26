import { describe, it, expect, vi, afterEach } from "vitest";
import { resolveSpecialization } from "./run.js";

describe("resolveSpecialization", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("prefers an explicit --specialization over anything persisted", () => {
    expect(resolveSpecialization({ repoPath: "/tmp/repo", specialization: "reviewer" }, "tester")).toBe("reviewer");
  });

  it("falls back to the specialization persisted at init time when none is given on the command line", () => {
    expect(resolveSpecialization({ repoPath: "/tmp/repo" }, "reviewer")).toBe("reviewer");
  });

  it("falls back to writer when nothing was persisted", () => {
    expect(resolveSpecialization({ repoPath: "/tmp/repo" })).toBe("writer");
  });

  it("warns and falls back to writer when the persisted value is invalid", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(resolveSpecialization({ repoPath: "/tmp/repo" }, "bogus")).toBe("writer");
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("bogus"));
  });
});
