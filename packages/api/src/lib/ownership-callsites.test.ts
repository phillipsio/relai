// `callerMayActOnAgent` and `callerMayAdministerRepo` answer "may this caller
// do this to that agent/repo" and deliberately do NOT answer "is that agent in
// a repo this caller can reach". Their own comment says callers must already be
// repo-scoped, and for an owner that is the ONLY thing confining them: the
// guard itself returns true for any target.
//
// So a call site that forgets `assertAgentAccess`/`assertRepoAccess` hands an
// owner-scoped caller every agent on the instance, and the guard will happily
// agree. That invariant was verified by reading all five route files once. This
// re-derives it mechanically, because the next call site is the one nobody
// re-reads.
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROUTES = join(__dirname, "..", "routes");
const GUARD = /\b(callerMayActOnAgent|callerMayAdministerRepo)\s*\(/;
const SCOPED = /\b(assertAgentAccess|assertRepoAccess)\s*\(/;
// A route registration or a plain function: the unit a guard's scoping must
// live inside. Anything further back belongs to a different caller.
const BOUNDARY = /(fastify\.(get|post|put|delete|patch)\b|^(export )?(async )?function \w|^(export )?const \w+ = async)/;

type Site = { file: string; line: number; text: string; scoped: boolean };

function guardSites(): Site[] {
  const sites: Site[] = [];
  for (const name of readdirSync(ROUTES).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))) {
    const lines = readFileSync(join(ROUTES, name), "utf8").split("\n");
    lines.forEach((text, i) => {
      if (!GUARD.test(text) || text.trimStart().startsWith("//")) return;
      let scoped = false;
      for (let j = i - 1; j >= 0; j--) {
        if (SCOPED.test(lines[j])) { scoped = true; break; }
        if (BOUNDARY.test(lines[j])) break;
      }
      sites.push({ file: name, line: i + 1, text: text.trim(), scoped });
    });
  }
  return sites;
}

describe("every guard call site is repo-scoped first", () => {
  it("finds the call sites at all, so a passing result means something", () => {
    const sites = guardSites();
    // Five route files used these when this was written. A crash or a moved
    // directory would otherwise report zero sites and pass silently.
    expect(sites.length).toBeGreaterThanOrEqual(10);
    expect(new Set(sites.map((s) => s.file)).size).toBeGreaterThanOrEqual(4);
  });

  it("has no site that consults a guard without first establishing reach", () => {
    const unscoped = guardSites().filter((s) => !s.scoped);
    expect(
      unscoped.map((s) => `${s.file}:${s.line}  ${s.text}`),
      "a guard here returns true for an owner against ANY agent; add assertAgentAccess/assertRepoAccess above it",
    ).toEqual([]);
  });

  it("detects an unscoped site rather than passing whatever it is given", () => {
    // Proves the walk-back terminates at a boundary instead of finding an
    // assert belonging to some earlier handler.
    const lines = [
      "  fastify.post(\"/a\", async (request, reply) => {",
      "    const access = await assertAgentAccess(request, db, id);",
      "    if (!callerMayActOnAgent(request, id)) return;",
      "  });",
      "  fastify.post(\"/b\", async (request, reply) => {",
      "    if (!callerMayActOnAgent(request, id)) return;",
      "  });",
    ];
    const verdicts = lines.map((text, i) => {
      if (!GUARD.test(text)) return null;
      for (let j = i - 1; j >= 0; j--) {
        if (SCOPED.test(lines[j])) return true;
        if (BOUNDARY.test(lines[j])) return false;
      }
      return false;
    }).filter((v) => v !== null);

    expect(verdicts).toEqual([true, false]);
  });
});
