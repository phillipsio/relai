// `tasks.updatedAt` is read as "when did anything last touch this row" by three
// separate features: detectStalls (in_progress gone quiet), the review-overdue
// nudge (awaiting a decision since), and the "Not picked up" label (assigned and
// never started). The column has no $onUpdate — deliberately, because bookkeeping
// writes like the verify claim and the DELETE /agents pointer sweep would then
// read as activity and reset all three clocks.
//
// So every writer that changes tasks.status has to stamp it by hand, and five of
// the six did not. A task routed from pending to assigned kept the updatedAt it
// was created with, and a task released from blocked kept one hours old, so both
// read as "Not picked up" the instant they were handed to someone.
//
// This is an inventory, not a behaviour test. A failure is NOT fixed by updating
// the literal: work out whether the new site is a real status transition, add
// `updatedAt: new Date()` if it is, and update the literal last.
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const SRC = join(__dirname, "..");

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) {
      if (entry !== "test") sourceFiles(p, out);
    } else if (entry.endsWith(".ts") && !entry.endsWith(".test.ts")) {
      out.push(p);
    }
  }
  return out;
}

const norm = (line: string) => line.replace(/\/\/.*$/, "").trim().replace(/\s+/g, " ");

// An `.update(tasks)` whose `.set({...})` names `status`. The set object may run
// over several lines, so the statement is read to its terminating `;`.
function statusWrites(files: Array<{ name: string; text: string }>) {
  const found: string[] = [];
  for (const { name, text } of files) {
    const lines = text.split("\n").map(norm);
    lines.forEach((line, i) => {
      if (!/\.update\(tasks\)/.test(line)) return;
      const stmt: string[] = [];
      for (let j = i; j < Math.min(i + 20, lines.length); j++) {
        if (!lines[j]) continue;
        stmt.push(lines[j]);
        if (/;$/.test(lines[j])) break;
      }
      const joined = stmt.join(" ");
      if (!/\bstatus:/.test(joined)) return;
      found.push(`${name}:${i + 1}  stamps=${/\bupdatedAt:/.test(joined)}`);
    });
  }
  return found.sort();
}

function realWrites() {
  return statusWrites(
    sourceFiles(SRC)
      .sort()
      .map((p) => ({ name: relative(SRC, p).split("\\").join("/"), text: readFileSync(p, "utf8") })),
  );
}

describe("every write that changes a task's status stamps updatedAt", () => {
  it("finds the writes at all, so a passing result means something", () => {
    expect(sourceFiles(SRC).length).toBeGreaterThan(20);
    expect(realWrites().length).toBeGreaterThanOrEqual(6);
  });

  it("leaves none of them unstamped", () => {
    const unstamped = realWrites().filter((w) => w.endsWith("stamps=false"));
    expect(
      unstamped,
      "this write changes tasks.status without moving updatedAt, so the row will read as untouched: add `updatedAt: new Date()`",
    ).toEqual([]);
  });

  it("reads a multi-line set object rather than only the first line", () => {
    // The two blocked-task resumes span six lines each. A line-at-a-time check
    // would call both of them status-free and pass while they were broken.
    const probe = statusWrites([
      {
        name: "routes/multi.ts",
        text: [
          "await db.update(tasks).set({",
          "  status: \"assigned\",",
          "  metadata: { ...meta },",
          "}).where(eq(tasks.id, task.id));",
          "await db.update(tasks).set({",
          "  status: \"pending\",",
          "  updatedAt: new Date(),",
          "}).where(eq(tasks.id, task.id));",
          "await db.update(tasks).set({ stalledAt: new Date() }).where(eq(tasks.id, task.id));",
        ].join("\n"),
      },
    ]);
    // The third write touches no status and must not be reported at all.
    expect(probe).toEqual([
      "routes/multi.ts:1  stamps=false",
      "routes/multi.ts:5  stamps=true",
    ]);
  });
});
