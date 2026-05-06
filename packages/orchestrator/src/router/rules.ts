import type { AgentRow, TaskRow } from "../api-client.js";

export interface RoutingResult {
  agentId: string;
  rationale: string;
  method: "rules" | "claude";
}

// Rules-based routing — zero Claude calls, zero token cost.
// Returns null when rules can't confidently resolve; Claude handles the rest.
export function tryRulesRouting(
  task: TaskRow,
  agents: AgentRow[],
  taskCounts: Record<string, number> = {},
): RoutingResult | null {
  const now = Date.now();
  const onlineAgents = agents.filter((a) => {
    const age = now - new Date(a.lastSeenAt).getTime();
    return age < 10 * 60 * 1000;
  });

  if (onlineAgents.length === 0) return null;

  // If the task requests a specific specialization, restrict the working set to those agents.
  // Specialization is a stronger signal than domain overlap — a reviewer task should never
  // route to a writer just because the writer happens to own the relevant domains.
  // Fall back to all online agents if no specialization match exists.
  const specFiltered = task.specialization
    ? onlineAgents.filter((a) => a.specialization === task.specialization)
    : [];
  const workingSet = specFiltered.length > 0 ? specFiltered : onlineAgents;

  // Rule 1: exact domain match — task domains are a subset of agent domains
  if (task.domains.length > 0) {
    const exactMatches = workingSet.filter((a) =>
      task.domains.every((d) => a.domains.includes(d))
    );
    if (exactMatches.length === 1) {
      return {
        agentId: exactMatches[0].id,
        rationale: `Exact domain match: agent owns [${task.domains.join(", ")}]`,
        method: "rules",
      };
    }
    if (exactMatches.length > 1) {
      // Rule 1a: specialization tiebreaker among exact matches
      const winner = specializationTiebreak(exactMatches, task.specialization);
      if (winner) {
        return {
          agentId: winner.id,
          rationale: `Exact domain match + specialization tiebreak: ${winner.specialization}`,
          method: "rules",
        };
      }
      // Rule 1b: load-balance tiebreaker
      const winner2 = loadBalanceTiebreak(exactMatches, taskCounts);
      if (winner2) {
        return {
          agentId: winner2.id,
          rationale: `Exact domain match + load balance (fewest active tasks)`,
          method: "rules",
        };
      }
      // Rule 1c: deterministic tiebreak — alphabetical by agent ID
      return {
        agentId: exactMatches.slice().sort((a, b) => a.id.localeCompare(b.id))[0].id,
        rationale: `Exact domain match + deterministic tiebreak`,
        method: "rules",
      };
    }

    // Rule 2: partial match — agent shares at least one domain with the task
    const partialMatches = workingSet.filter((a) =>
      task.domains.some((d) => a.domains.includes(d))
    );
    if (partialMatches.length === 1) {
      return {
        agentId: partialMatches[0].id,
        rationale: `Partial domain match: agent covers some of [${task.domains.join(", ")}]`,
        method: "rules",
      };
    }
    if (partialMatches.length > 1) {
      // Rule 2a: specialization tiebreaker among partial matches
      const winner = specializationTiebreak(partialMatches, task.specialization);
      if (winner) {
        return {
          agentId: winner.id,
          rationale: `Partial domain match + specialization tiebreak: ${winner.specialization}`,
          method: "rules",
        };
      }
      // Rule 2b: domain overlap count tiebreaker — most overlapping domains wins
      const winner2 = domainOverlapTiebreak(partialMatches, task.domains);
      if (winner2) {
        const overlap = task.domains.filter((d) => winner2.domains.includes(d));
        return {
          agentId: winner2.id,
          rationale: `Best domain overlap: agent matches [${overlap.join(", ")}]`,
          method: "rules",
        };
      }
      // Rule 2c: load-balance tiebreaker
      const winner3 = loadBalanceTiebreak(partialMatches, taskCounts);
      if (winner3) {
        return {
          agentId: winner3.id,
          rationale: `Partial domain match + load balance (fewest active tasks)`,
          method: "rules",
        };
      }
      // Rule 2d: deterministic tiebreak — alphabetical by agent ID
      return {
        agentId: partialMatches.slice().sort((a, b) => a.id.localeCompare(b.id))[0].id,
        rationale: `Partial domain match + deterministic tiebreak`,
        method: "rules",
      };
    }
  }

  // Rule 3: specialization match — works when task has no domain constraints,
  // or when domain rules couldn't resolve. If specFiltered was empty above,
  // workingSet is the unfiltered onlineAgents — say so in the rationale instead
  // of claiming a specialization match that didn't happen.
  const matchedSpec = specFiltered.length > 0;
  const specPrefix = matchedSpec
    ? `Specialization match: ${task.specialization}`
    : `No online agent with specialization '${task.specialization}' — load balanced among online agents`;
  if (task.specialization && workingSet.length === 1) {
    return {
      agentId: workingSet[0].id,
      rationale: specPrefix,
      method: "rules",
    };
  }
  if (task.specialization && workingSet.length > 1) {
    const winner = loadBalanceTiebreak(workingSet, taskCounts);
    if (winner) {
      return {
        agentId: winner.id,
        rationale: matchedSpec
          ? `Specialization match + load balance: ${task.specialization}`
          : specPrefix,
        method: "rules",
      };
    }
    return {
      agentId: workingSet.slice().sort((a, b) => a.id.localeCompare(b.id))[0].id,
      rationale: matchedSpec
        ? `Specialization match + deterministic tiebreak: ${task.specialization}`
        : specPrefix,
      method: "rules",
    };
  }

  // Rule 4: no domains, no specialization + exactly one online agent → assign directly
  if (task.domains.length === 0 && workingSet.length === 1) {
    return {
      agentId: workingSet[0].id,
      rationale: "Only one agent online and task has no domain constraint",
      method: "rules",
    };
  }

  // Rule 4b: no domains + multiple agents → load balance
  if (task.domains.length === 0 && workingSet.length > 1) {
    const winner = loadBalanceTiebreak(workingSet, taskCounts);
    if (winner) {
      return {
        agentId: winner.id,
        rationale: `No domain constraint + load balance (fewest active tasks)`,
        method: "rules",
      };
    }
  }

  return null;
}

// Pick the single agent whose specialization matches the task's requested specialization.
// Returns null if there's no match or the match is not unique.
function specializationTiebreak(
  agents: AgentRow[],
  taskSpecialization: string | null | undefined,
): AgentRow | null {
  if (!taskSpecialization) return null;
  const matches = agents.filter((a) => a.specialization === taskSpecialization);
  return matches.length === 1 ? matches[0] : null;
}

// Pick the single agent with the highest number of overlapping domains with the task.
// Returns null if the top count is shared by multiple agents (still ambiguous).
function domainOverlapTiebreak(agents: AgentRow[], taskDomains: string[]): AgentRow | null {
  const scored = agents.map((a) => ({
    agent: a,
    score: taskDomains.filter((d) => a.domains.includes(d)).length,
  }));
  const max = Math.max(...scored.map((s) => s.score));
  const winners = scored.filter((s) => s.score === max);
  return winners.length === 1 ? winners[0].agent : null;
}

// Pick the agent with the fewest in-progress tasks. Returns null if tied.
function loadBalanceTiebreak(agents: AgentRow[], taskCounts: Record<string, number>): AgentRow | null {
  const scored = agents.map((a) => ({ agent: a, count: taskCounts[a.id] ?? 0 }));
  const min = Math.min(...scored.map((s) => s.count));
  const leastBusy = scored.filter((s) => s.count === min);
  return leastBusy.length === 1 ? leastBusy[0].agent : null;
}

// Exported for use as a last-resort fallback in the router.
// Unlike loadBalanceTiebreak, this always returns the best candidate even when tied —
// breaking ties by whichever agent sorts first (deterministic, not null).
export function leastBusyAgent(agents: AgentRow[], taskCounts: Record<string, number>): AgentRow | null {
  if (agents.length === 0) return null;
  return agents.reduce((best, a) =>
    (taskCounts[a.id] ?? 0) <= (taskCounts[best.id] ?? 0) ? a : best
  );
}
