import { InvalidArgumentError } from "commander";
import type { Specialization } from "@getrelai/claude-worker";

const VALID: Specialization[] = ["reviewer", "architect", "writer", "tester", "devops"];

// Shared commander argParser for every --specialization flag in this CLI, so
// an invalid value fails fast at parse time instead of silently degrading
// into a roleless prompt later (claude-worker's specializationBlock() now
// throws on an unknown value too — this is the earlier, friendlier checkpoint).
export function parseSpecialization(value: string): Specialization {
  if (!VALID.includes(value as Specialization)) {
    throw new InvalidArgumentError(`must be one of: ${VALID.join(", ")}`);
  }
  return value as Specialization;
}
