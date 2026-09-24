// `tokens.ownerId` is the super-agent credential. The auth plugin copies it onto
// `request.ownerId`, and `assertRepoAccess` then admits the holder to every repo
// that user owns, so it is the widest authority the API issues. Four review
// rounds in a row each found a defect here, and each found a DIFFERENT path,
// because a diff review only sees the path that commit touched. A fifth was
// then found by auditing the surface instead.
//
// This pins the surface rather than one path through it. It is an inventory,
// not a behaviour test: it fails when a mint, the expression a mint takes its
// scope from, the query that reads the column, or a writer of `request.ownerId`
// appears, changes, or moves into a file nobody reviewed for it.
//
// A failure is NOT fixed by updating the literal. Work out what the new site
// does with owner scope, decide that it is right, and update the literal last.
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

type ScopeFacts = {
  mints: string[];
  sources: string[];
  reads: string[];
  requestWriters: string[];
  strayColumnRefs: string[];
};

const MINT = /\.insert\((tokens|invites)\)/;
const OWNER_KEY = /\bownerId\s*:\s*([^,}]+)/;
const COLUMN = /\b(tokens|invites)\.ownerId\b|\bdeviceAuthorizations\.(scope|claimedBy)\b/;
const TOKEN_COLUMN = /\btokens\.ownerId\b/;
const CALLER_SUPPLIED = /\bbody\b|request\.(query|params|headers|body)/;

// The files reviewed as carriers of owner scope. Any other file may read
// `request.ownerId` (tenant filters do) but must not touch a column that
// decides it.
const CARRIERS = new Set([
  "plugins/auth.ts",
  "routes/agents.ts",
  "routes/device-auth.ts",
  "routes/invites.ts",
]);

function scopeFacts(files: Array<{ name: string; text: string }>): ScopeFacts {
  const facts: ScopeFacts = { mints: [], sources: [], reads: [], requestWriters: [], strayColumnRefs: [] };

  for (const { name, text } of files) {
    const lines = text.split("\n").map(norm);

    lines.forEach((line, i) => {
      if (MINT.test(line)) {
        const table = MINT.exec(line)![1];
        let expr = "(unset)";
        for (let j = i; j < Math.min(i + 25, lines.length); j++) {
          if (j > i && /^\}\)/.test(lines[j])) break;
          const key = OWNER_KEY.exec(lines[j]);
          if (key) { expr = key[1].trim().replace(/,$/, ""); break; }
        }
        facts.mints.push(`${name}  insert(${table}) ownerId: ${expr}`);

        // A bare identifier hides the decision one line up. Pin the whole
        // initialiser, or re-pointing it at another row passes unnoticed.
        if (/^[A-Za-z_$][\w$]*$/.test(expr)) {
          const start = lines.findIndex((l) => new RegExp(`^const ${expr}\\s*=`).test(l));
          if (start === -1) {
            facts.sources.push(`${name}  ${expr} = (no initialiser found)`);
          } else {
            const parts: string[] = [];
            for (let j = start; j < lines.length; j++) {
              parts.push(lines[j]);
              if (lines[j].endsWith(";")) break;
            }
            facts.sources.push(`${name}  ${parts.join(" ")}`);
          }
        }
      }

      // The statement around a read, not the read alone: the predicates that
      // keep a revoked row out of a rotation sit on the lines after it.
      if (TOKEN_COLUMN.test(line)) {
        const stmt: string[] = [];
        for (let j = i; j < Math.min(i + 7, lines.length); j++) {
          if (!lines[j]) continue;
          stmt.push(lines[j]);
          if (lines[j].endsWith(";")) break;
        }
        facts.reads.push(`${name}  ${stmt.join(" ")}`);
      }

      if (/request\.ownerId\s*=[^=]/.test(line)) facts.requestWriters.push(`${name}  ${line}`);
      if (COLUMN.test(line) && !CARRIERS.has(name)) facts.strayColumnRefs.push(`${name}  ${line}`);
    });
  }

  facts.mints.sort();
  facts.sources.sort();
  facts.reads.sort();
  facts.requestWriters.sort();
  facts.strayColumnRefs.sort();
  return facts;
}

function realFacts(): ScopeFacts {
  return scopeFacts(
    sourceFiles(SRC)
      .sort()
      .map((p) => ({ name: relative(SRC, p).split("\\").join("/"), text: readFileSync(p, "utf8") })),
  );
}

describe("owner scope on a credential has a pinned set of call sites", () => {
  it("finds the surface at all, so a passing result means something", () => {
    expect(sourceFiles(SRC).length).toBeGreaterThan(20);
    const facts = realFacts();
    expect(facts.mints.length).toBeGreaterThanOrEqual(4);
    expect(facts.sources.length).toBeGreaterThanOrEqual(1);
    expect(facts.reads.length).toBeGreaterThanOrEqual(3);
    expect(facts.requestWriters.length).toBeGreaterThanOrEqual(2);
  });

  it("mints credentials at exactly these sites, with exactly these scope expressions", () => {
    // Each checked against what it is meant to do before being pinned:
    // registration mints unscoped; rotation carries via the ternary below;
    // device-auth is the ONLY owner-scoped invite mint and takes it from
    // claimedBy; the ordinary invite route never sets it; accept-invite reads
    // the row its conditional claim returned, not the pre-transaction read.
    expect(realFacts().mints).toEqual([
      "routes/agents.ts  insert(tokens) ownerId: (unset)",
      "routes/agents.ts  insert(tokens) ownerId: carriedOwnerId",
      "routes/device-auth.ts  insert(invites) ownerId: row.scope === \"owner\" ? row.claimedBy : null",
      "routes/invites.ts  insert(invites) ownerId: (unset)",
      "routes/invites.ts  insert(tokens) ownerId: claimed.ownerId ?? null",
    ]);
  });

  it("derives a minted scope from exactly this expression", () => {
    expect(realFacts().sources).toEqual([
      "routes/agents.ts  const carriedOwnerId = request.agent?.id === agent.id ? presenting?.ownerId ?? null : !request.agent && !!request.ownerId && request.ownerId === live?.ownerId ? live?.ownerId ?? null : null;",
    ]);
  });

  it("reads tokens.ownerId with exactly these queries, revoked rows excluded and the presenting row locked", () => {
    expect(realFacts().reads).toEqual([
      "routes/agents.ts  .select({ ownerId: tokens.ownerId }) .from(tokens) .where(and(eq(tokens.agentId, agent.id), isNull(tokens.revokedAt))) .orderBy(desc(tokens.createdAt)) .limit(1);",
      "routes/agents.ts  .select({ ownerId: tokens.ownerId }) .from(tokens) .where(and(eq(tokens.id, request.tokenId), isNull(tokens.revokedAt))) .for(\"update\") : [];",
      "routes/agents.ts  ownerId: tokens.ownerId, }) .from(tokens) .where(eq(tokens.agentId, check.agent.id)) .orderBy(desc(tokens.createdAt));",
    ]);
  });

  it("takes no minted scope from anything the caller sent", () => {
    const facts = realFacts();
    const tainted = [
      ...facts.mints.filter((m) => CALLER_SUPPLIED.test(m.split("ownerId:")[1] ?? "")),
      ...facts.sources.filter((s) => CALLER_SUPPLIED.test(s)),
    ];
    expect(
      tainted,
      "a credential's tenant must come from a row the server already trusts, never from the request",
    ).toEqual([]);
  });

  it("sets request.ownerId in exactly these two places", () => {
    expect(realFacts().requestWriters).toEqual([
      "plugins/auth.ts  if (row.token.ownerId) request.ownerId = row.token.ownerId;",
      "plugins/auth.ts  request.ownerId = ownerId;",
    ]);
  });

  it("keeps the deciding columns inside the reviewed files", () => {
    expect(
      realFacts().strayColumnRefs,
      "this file now touches a column that decides owner scope; review it against the rules above, then add it to CARRIERS",
    ).toEqual([]);
  });

  it("detects a smuggled scope, a silent mint and a stray column read rather than passing whatever it is given", () => {
    const facts = scopeFacts([
      {
        name: "routes/rogue.ts",
        text: [
          "const smuggled = body.data.ownerId;",
          "await db.insert(tokens).values({",
          "  id: newId(\"tok\"),",
          "  ownerId: smuggled,",
          "  tokenHash: hashToken(plaintext),",
          "});",
          "await db.select({ ownerId: tokens.ownerId }).from(tokens);",
        ].join("\n"),
      },
      {
        name: "routes/quiet.ts",
        text: ["await db.insert(tokens).values({", "  id: newId(\"tok\"),", "});"].join("\n"),
      },
    ]);

    expect(facts.mints).toEqual([
      "routes/quiet.ts  insert(tokens) ownerId: (unset)",
      "routes/rogue.ts  insert(tokens) ownerId: smuggled",
    ]);
    expect(facts.sources).toEqual(["routes/rogue.ts  const smuggled = body.data.ownerId;"]);
    expect(facts.sources.filter((s) => CALLER_SUPPLIED.test(s))).toHaveLength(1);
    expect(facts.strayColumnRefs).toEqual([
      "routes/rogue.ts  await db.select({ ownerId: tokens.ownerId }).from(tokens);",
    ]);
  });
});
