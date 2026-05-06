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

  const specFiltered = task.specialization
    ? onlineAgents.filter((a) => a.specialization === task.specialization)
    : [];
  const workingSet = specFiltered.length > 0 ? specFiltered : onlineAgents;

  if (task.domains.length > 0) {
    const exactMatches = workingSet.filter((a) =>
      task.domains.every((d) => a.domains.includes(d))
    );
    if (exactMatches.length === 1) {
      return { agentId: exactMatches[0].id, rationale: `Exact domain match: [${task.domains.join(", ")}]`, method: "rules" };
    }
    if (exactMatches.length > 1) {
      const w = specializationTiebreak(exactMatches, task.specialization) ??
                loadBalanceTiebreak(exactMatches, taskCounts) ??
                exactMatches.slice().sort((a, b) => a.id.localeCompare(b.id))[0];
      return { agentId: w.id, rationale: "Exact domain match + tiebreak", method: "rules" };
    }

    const partialMatches = workingSet.filter((a) =>
      task.domains.some((d) => a.domains.includes(d))
    );
    if (partialMatches.length === 1) {
      return { agentId: partialMatches[0].id, rationale: `Partial domain match: [${task.domains.join(", ")}]`, method: "rules" };
    }
    if (partialMatches.length > 1) {
      const w = specializationTiebreak(partialMatches, task.specialization) ??
                domainOverlapTiebreak(partialMatches, task.domains) ??
                loadBalanceTiebreak(partialMatches, taskCounts) ??
                partialMatches.slice().sort((a, b) => a.id.localeCompare(b.id))[0];
      return { agentId: w.id, rationale: "Partial domain match + tiebreak", method: "rules" };
    }
  }

  if (task.specialization && workingSet.length >= 1) {
    const w = loadBalanceTiebreak(workingSet, taskCounts) ??
              workingSet.slice().sort((a, b) => a.id.localeCompare(b.id))[0];
    const matchedSpec = specFiltered.length > 0;
    const rationale = matchedSpec
      ? `Specialization match: ${task.specialization}`
      : `No online agent with specialization '${task.specialization}' — load balanced among online agents`;
    return { agentId: w.id, rationale, method: "rules" };
  }

  if (task.domains.length === 0) {
    const w = loadBalanceTiebreak(workingSet, taskCounts) ?? workingSet[0];
    return { agentId: w.id, rationale: "No domain constraint — load balanced", method: "rules" };
  }

  return null;
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
