import { describe, it, expect } from "vitest";
import { tryRulesRouting } from "./rules.js";
import type { AgentRow, TaskRow } from "../api-client.js";

// Helpers
const now = new Date().toISOString();
const stale = new Date(Date.now() - 11 * 60 * 1000).toISOString(); // 11 min ago → offline

function agent(id: string, domains: string[], opts: { specialization?: string; tier?: number; lastSeenAt?: string } = {}): AgentRow {
  return { id, name: id, role: "worker", domains, specialization: opts.specialization, tier: opts.tier, lastSeenAt: opts.lastSeenAt ?? now };
}

function task(id: string, domains: string[], specialization?: string): TaskRow {
  return { id, title: id, description: "", status: "pending", priority: "normal", domains, specialization, metadata: {}, createdAt: now };
}

describe("tryRulesRouting", () => {
  describe("online filter", () => {
    it("returns null when all agents are stale", () => {
      const result = tryRulesRouting(task("t1", ["typescript"]), [
        agent("a1", ["typescript"], { lastSeenAt: stale }),
      ]);
      expect(result).toBeNull();
    });

    it("only considers agents seen within 10 minutes", () => {
      const result = tryRulesRouting(task("t1", ["typescript"]), [
        agent("a1", ["typescript"], { lastSeenAt: stale }),
        agent("a2", ["react"]),
      ]);
      expect(result).toBeNull();
    });
  });

  describe("Rule 1: exact domain match", () => {
    it("assigns when one agent owns all task domains", () => {
      const result = tryRulesRouting(task("t1", ["typescript", "react"]), [
        agent("a1", ["typescript", "react", "api"]),
        agent("a2", ["python"]),
      ]);
      expect(result).toMatchObject({ agentId: "a1", method: "rules" });
      expect(result?.rationale).toMatch(/exact domain match/i);
    });

    it("picks alphabetically first when multiple agents match exactly with no other tiebreaker", () => {
      const result = tryRulesRouting(task("t1", ["typescript"]), [
        agent("a1", ["typescript", "react"]),
        agent("a2", ["typescript", "api"]),
      ]);
      expect(result).toMatchObject({ agentId: "a1", method: "rules" });
    });
  });

  describe("Rule 1a: specialization tiebreak among exact matches", () => {
    it("picks the agent whose specialization matches the task", () => {
      const result = tryRulesRouting(
        task("t1", ["typescript"], "writer"),
        [
          agent("a1", ["typescript", "react"], { specialization: "writer" }),
          agent("a2", ["typescript", "api"],   { specialization: "reviewer" }),
        ],
      );
      // specialization pre-filter narrows to a1 only → exact match wins directly
      expect(result).toMatchObject({ agentId: "a1", method: "rules" });
    });

    it("picks alphabetically first when multiple agents share the same specialization", () => {
      const result = tryRulesRouting(
        task("t1", ["typescript"], "writer"),
        [
          agent("a1", ["typescript"], { specialization: "writer" }),
          agent("a2", ["typescript"], { specialization: "writer" }),
        ],
      );
      expect(result).toMatchObject({ agentId: "a1", method: "rules" });
    });

    it("falls back to all agents when no agent matches the requested specialization", () => {
      const result = tryRulesRouting(
        task("t1", ["typescript"], "tester"),
        [
          agent("a1", ["typescript"], { specialization: "writer" }),
          agent("a2", ["typescript"], { specialization: "reviewer" }),
        ],
      );
      // No spec match → falls back to all online → deterministic tiebreak
      expect(result).toMatchObject({ agentId: "a1", method: "rules" });
    });

    it("logs an honest rationale when the spec filter empties out and the spec-fallback path resolves", () => {
      // No task domains → Rule 1/2 (domain-match) skipped.
      // Task wants "tester" but no agent is one → specFiltered empty,
      // workingSet falls back to all online agents, Rule 3 fires.
      // The rationale must NOT claim "Specialization match: tester" — that
      // would be a lie. The routing log is the only post-hoc explanation
      // for a decision; it has to tell the truth.
      const result = tryRulesRouting(
        task("t1", [], "tester"),
        [
          agent("a1", ["typescript"], { specialization: "writer" }),
          agent("a2", ["typescript"], { specialization: "reviewer" }),
        ],
      );
      expect(result?.method).toBe("rules");
      expect(result?.rationale).toContain("No online agent with specialization 'tester'");
      expect(result?.rationale).not.toContain("Specialization match: tester");
    });
  });

  describe("Rule 2: partial domain match", () => {
    it("assigns when exactly one agent shares any task domain", () => {
      const result = tryRulesRouting(task("t1", ["typescript", "react"]), [
        agent("a1", ["typescript"]),
        agent("a2", ["python"]),
      ]);
      expect(result).toMatchObject({ agentId: "a1", method: "rules" });
      expect(result?.rationale).toMatch(/partial/i);
    });

    it("picks alphabetically first when multiple agents partially match with no other tiebreaker", () => {
      const result = tryRulesRouting(task("t1", ["typescript", "react"]), [
        agent("a1", ["typescript"]),
        agent("a2", ["react"]),
      ]);
      expect(result).toMatchObject({ agentId: "a1", method: "rules" });
    });
  });

  describe("Rule 2a: specialization tiebreak among partial matches", () => {
    it("picks the agent whose specialization matches when domains are ambiguous", () => {
      const result = tryRulesRouting(
        task("t1", ["typescript", "review"], "reviewer"),
        [
          agent("a1", ["typescript", "api"],         { specialization: "writer" }),
          agent("a2", ["review", "code-quality"],     { specialization: "reviewer" }),
        ],
      );
      expect(result).toMatchObject({ agentId: "a2", method: "rules" });
    });
  });

  describe("Rule 2b: domain overlap count tiebreak among partial matches", () => {
    it("picks the agent with more overlapping domains", () => {
      const result = tryRulesRouting(task("t1", ["typescript", "react", "api"]), [
        agent("a1", ["typescript", "react"]), // 2 overlaps
        agent("a2", ["api"]),                 // 1 overlap
      ]);
      expect(result).toMatchObject({ agentId: "a1", method: "rules" });
      expect(result?.rationale).toMatch(/best domain overlap/i);
    });

    it("picks alphabetically first when overlap counts are tied", () => {
      const result = tryRulesRouting(task("t1", ["typescript", "react"]), [
        agent("a1", ["typescript"]), // 1 overlap
        agent("a2", ["react"]),      // 1 overlap
      ]);
      expect(result).toMatchObject({ agentId: "a1", method: "rules" });
    });
  });

  describe("Rule 3: no-domain task + single online agent", () => {
    it("assigns to the only online agent when task has no domains", () => {
      const result = tryRulesRouting(task("t1", []), [
        agent("a1", ["typescript"]),
      ]);
      expect(result).toMatchObject({ agentId: "a1", method: "rules" });
      expect(result?.rationale).toMatch(/only one agent/i);
    });

    it("load-balances when task has no domains and multiple agents are online", () => {
      const result = tryRulesRouting(task("t1", []), [
        agent("a1", ["typescript"]),
        agent("a2", ["python"]),
      ], { a1: 3, a2: 1 });
      expect(result).toMatchObject({ agentId: "a2", method: "rules" });
    });

    it("returns null when task has no domains and no agents are online", () => {
      const result = tryRulesRouting(task("t1", []), []);
      expect(result).toBeNull();
    });
  });

  describe("unroutable cases", () => {
    it("returns null when no agents share any task domain", () => {
      const result = tryRulesRouting(task("t1", ["go", "kubernetes"]), [
        agent("a1", ["typescript"]),
        agent("a2", ["python"]),
      ]);
      expect(result).toBeNull();
    });
  });

  describe("specialization pre-filter", () => {
    it("routes reviewer task to reviewer agent even when writer owns matching domains", () => {
      const result = tryRulesRouting(
        task("t1", ["typescript", "api"], "reviewer"),
        [
          agent("a1", ["typescript", "api"], { specialization: "writer" }),
          agent("a2", ["review"],             { specialization: "reviewer" }),
        ],
      );
      expect(result).toMatchObject({ agentId: "a2", method: "rules" });
    });

    it("falls back to all agents when no agent has the requested specialization", () => {
      const result = tryRulesRouting(
        task("t1", ["typescript"], "tester"),
        [
          agent("a1", ["typescript"], { specialization: "writer" }),
          agent("a2", ["typescript"], { specialization: "reviewer" }),
        ],
      );
      expect(result).toMatchObject({ agentId: "a1", method: "rules" });
    });
  });

  describe("load balancing", () => {
    it("picks the least busy agent when domains are tied", () => {
      const result = tryRulesRouting(
        task("t1", ["typescript"]),
        [
          agent("a1", ["typescript"]),
          agent("a2", ["typescript"]),
        ],
        { a1: 3, a2: 1 },
      );
      expect(result).toMatchObject({ agentId: "a2", method: "rules" });
      expect(result?.rationale).toMatch(/load balance/i);
    });

    it("picks alphabetically first when task counts are tied", () => {
      const result = tryRulesRouting(
        task("t1", ["typescript"]),
        [
          agent("a1", ["typescript"]),
          agent("a2", ["typescript"]),
        ],
        { a1: 2, a2: 2 },
      );
      expect(result).toMatchObject({ agentId: "a1", method: "rules" });
    });

    it("treats missing task count as zero for load balancing", () => {
      const result = tryRulesRouting(
        task("t1", ["typescript"]),
        [
          agent("a1", ["typescript"]),
          agent("a2", ["typescript"]),
        ],
        { a1: 1 }, // a2 not in map → treated as 0
      );
      expect(result).toMatchObject({ agentId: "a2", method: "rules" });
    });
  });
});
