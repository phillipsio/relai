import { describe, it, expect } from "vitest";
import { InvalidArgumentError } from "commander";
import { parseSpecialization } from "./validate.js";

describe("parseSpecialization", () => {
  it("accepts every valid specialization", () => {
    for (const v of ["reviewer", "architect", "writer", "tester", "devops"]) {
      expect(parseSpecialization(v)).toBe(v);
    }
  });

  it("rejects an unknown value instead of passing it through", () => {
    expect(() => parseSpecialization("bogus")).toThrow(InvalidArgumentError);
  });
});
