import { InvalidArgumentError } from "commander";
import { VALID_SPECIALIZATIONS, type Specialization } from "@getrelai/claude-worker";

// Shared commander argParser for every --specialization flag in this CLI, so
// an invalid value fails fast at parse time instead of silently degrading
// into a roleless prompt later (claude-worker's specializationBlock() now
// throws on an unknown value too — this is the earlier, friendlier checkpoint).
export function parseSpecialization(value: string): Specialization {
  if (!VALID_SPECIALIZATIONS.includes(value as Specialization)) {
    throw new InvalidArgumentError(`must be one of: ${VALID_SPECIALIZATIONS.join(", ")}`);
  }
  return value as Specialization;
}
