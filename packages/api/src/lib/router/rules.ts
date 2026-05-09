// Rules-based routing — zero Claude calls, zero token cost.
// Returns null when rules can't confidently resolve; Claude handles the rest.
//
// Rationale strings are surfaced verbatim in the routing log. Keep them
// specific — "Exact domain match + load balance (fewest active tasks)" is a
// useful breadcrumb for debugging "why did this task land on agent X?";
// "tiebreak" is not.

export interface AgentRow {
  id: string;
  name: string;
  specialization?: string | null;
  tier?: number | null;
  domains: string[];
  lastSeenAt: string | Date;
}

export interface TaskRow {
  id: string;
  title: string;
  description: string;
  domains: string[];
  specialization?: string | null;
  priority: string;
  metadata: Record<string, unknown>;
}

export interface RoutingResult {
  agentId: string;
  rationale: string;
  method: "rules" | "claude";
}

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

  // Specialization is a stronger signal than domain overlap — a reviewer task
  // should never route to a writer just because the writer happens to own the
  // relevant domains. Fall back to all online agents only when no specialization
  // match exists, and tell the truth about it in the rationale.
  const specFiltered = task.specialization
    ? onlineAgents.filter((a) => a.specialization === task.specialization)
    : [];
  const workingSet = specFiltered.length > 0 ? specFiltered : onlineAgents;
  const matchedSpec = specFiltered.length > 0;
  const specFallbackNote = task.specialization && !matchedSpec
    ? `No online agent with specialization '${task.specialization}' — load balanced among online agents`
    : null;

  // Rule 1: exact domain match — task domains are a subset of agent domains.
  if (task.domains.length > 0) {
    const exactMatches = workingSet.filter((a) =>
      task.domains.every((d) => a.domains.includes(d))
    );
    if (exactMatches.length === 1) {
      return rules(exactMatches[0], `Exact domain match: agent owns [${task.domains.join(", ")}]`);
    }
    if (exactMatches.length > 1) {
      const specWinner = specializationTiebreak(exactMatches, task.specialization);
      if (specWinner) {
        return rules(specWinner, `Exact domain match + specialization tiebreak: ${specWinner.specialization}`);
      }
      const lbWinner = loadBalanceTiebreak(exactMatches, taskCounts);
      if (lbWinner) {
        return rules(lbWinner, "Exact domain match + load balance (fewest active tasks)");
      }
      return rules(alphabeticallyFirst(exactMatches), "Exact domain match + deterministic tiebreak");
    }

    // Rule 2: partial match — agent shares at least one domain with the task.
    const partialMatches = workingSet.filter((a) =>
      task.domains.some((d) => a.domains.includes(d))
    );
    if (partialMatches.length === 1) {
      return rules(partialMatches[0], `Partial domain match: agent covers some of [${task.domains.join(", ")}]`);
    }
    if (partialMatches.length > 1) {
      const specWinner = specializationTiebreak(partialMatches, task.specialization);
      if (specWinner) {
        return rules(specWinner, `Partial domain match + specialization tiebreak: ${specWinner.specialization}`);
      }
      const overlapWinner = domainOverlapTiebreak(partialMatches, task.domains);
      if (overlapWinner) {
        const overlap = task.domains.filter((d) => overlapWinner.domains.includes(d));
        return rules(overlapWinner, `Best domain overlap: agent matches [${overlap.join(", ")}]`);
      }
      const lbWinner = loadBalanceTiebreak(partialMatches, taskCounts);
      if (lbWinner) {
        return rules(lbWinner, "Partial domain match + load balance (fewest active tasks)");
      }
      return rules(alphabeticallyFirst(partialMatches), "Partial domain match + deterministic tiebreak");
    }
  }

  // Rule 3: specialization match — fires when the task asks for a specialization
  // and either had no domain constraints or the domain rules couldn't resolve.
  // The rationale must reflect whether the spec actually matched: an honest log
  // is the only post-hoc explanation for a routing decision.
  if (task.specialization && workingSet.length > 0) {
    if (workingSet.length === 1) {
      const rationale = matchedSpec
        ? `Specialization match: ${task.specialization}`
        : specFallbackNote!;
      return rules(workingSet[0], rationale);
    }
    const lbWinner = loadBalanceTiebreak(workingSet, taskCounts);
    if (lbWinner) {
      const rationale = matchedSpec
        ? `Specialization match + load balance: ${task.specialization}`
        : specFallbackNote!;
      return rules(lbWinner, rationale);
    }
    const rationale = matchedSpec
      ? `Specialization match + deterministic tiebreak: ${task.specialization}`
      : specFallbackNote!;
    return rules(alphabeticallyFirst(workingSet), rationale);
  }

  // Rule 4: no domains and no specialization. Always resolve — single agent
  // gets it directly; multiple agents go through load balance with an
  // alphabetical fallback so a tied no-domain queue doesn't depend on the
  // database row order.
  if (task.domains.length === 0) {
    if (workingSet.length === 1) {
      return rules(workingSet[0], "Only one agent online and task has no domain constraint");
    }
    const lbWinner = loadBalanceTiebreak(workingSet, taskCounts);
    if (lbWinner) {
      return rules(lbWinner, "No domain constraint + load balance (fewest active tasks)");
    }
    return rules(alphabeticallyFirst(workingSet), "No domain constraint + deterministic tiebreak");
  }

  return null;
}

function rules(agent: AgentRow, rationale: string): RoutingResult {
  return { agentId: agent.id, rationale, method: "rules" };
}

function alphabeticallyFirst(agents: AgentRow[]): AgentRow {
  return agents.slice().sort((a, b) => a.id.localeCompare(b.id))[0];
}

function specializationTiebreak(agents: AgentRow[], spec?: string | null): AgentRow | null {
  if (!spec) return null;
  const matches = agents.filter((a) => a.specialization === spec);
  return matches.length === 1 ? matches[0] : null;
}

function domainOverlapTiebreak(agents: AgentRow[], taskDomains: string[]): AgentRow | null {
  const scored = agents.map((a) => ({ agent: a, score: taskDomains.filter((d) => a.domains.includes(d)).length }));
  const max = Math.max(...scored.map((s) => s.score));
  const winners = scored.filter((s) => s.score === max);
  return winners.length === 1 ? winners[0].agent : null;
}

function loadBalanceTiebreak(agents: AgentRow[], taskCounts: Record<string, number>): AgentRow | null {
  const scored = agents.map((a) => ({ agent: a, count: taskCounts[a.id] ?? 0 }));
  const min = Math.min(...scored.map((s) => s.count));
  const leastBusy = scored.filter((s) => s.count === min);
  return leastBusy.length === 1 ? leastBusy[0].agent : null;
}
