import { describe, it, expect, afterEach } from "vitest";
import { taskLabel } from "./task-label.js";
import { DEFAULT_UNSTARTED_AFTER_MS } from "@getrelai/types";

const before = process.env.UNSTARTED_AFTER_MS;
afterEach(() => {
  if (before === undefined) delete process.env.UNSTARTED_AFTER_MS;
  else process.env.UNSTARTED_AFTER_MS = before;
});

const assignedAgo = (ms: number) => ({ status: "assigned" as const, updatedAt: new Date(Date.now() - ms) });

describe("taskLabel resolves the threshold from the environment", () => {
  it("uses the shared default when nothing is set", () => {
    delete process.env.UNSTARTED_AFTER_MS;
    expect(taskLabel(assignedAgo(DEFAULT_UNSTARTED_AFTER_MS + 60_000))).toBe("Not picked up");
    expect(taskLabel(assignedAgo(DEFAULT_UNSTARTED_AFTER_MS - 60_000))).toBe("Starting");
  });

  it("honours a value set after this module was imported", () => {
    // The route reads it per call for exactly this reason: a test that sets the
    // variable at file scope runs after import, and a cached read would ignore it.
    process.env.UNSTARTED_AFTER_MS = "1000";
    expect(taskLabel(assignedAgo(5_000))).toBe("Not picked up");
    process.env.UNSTARTED_AFTER_MS = String(24 * 60 * 60 * 1000);
    expect(taskLabel(assignedAgo(5_000))).toBe("Starting");
  });
});

describe("a malformed threshold falls back instead of labelling everything", () => {
  // Number("") is 0, and `age >= 0` is true for a row written this millisecond,
  // so an empty value in api.env would tell every agent in every repo that its
  // assignment notice never arrived. A non-numeric value is the mirror image:
  // the comparison is always false and the feature is silently off.
  for (const bad of ["", "   ", "4h", "abc", "0", "-1", "NaN"]) {
    it(`falls back on ${JSON.stringify(bad)}`, () => {
      process.env.UNSTARTED_AFTER_MS = bad;
      expect(taskLabel(assignedAgo(1000))).toBe("Starting");
      expect(taskLabel(assignedAgo(DEFAULT_UNSTARTED_AFTER_MS + 60_000))).toBe("Not picked up");
    });
  }
});
