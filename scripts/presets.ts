/**
 * Role presets used by seed scripts. Each preset bundles a default
 * `specialization`, `domains`, and `tier` for a common agent role.
 *
 * Tier is operator-defined seniority for escalation routing — independent
 * of the agent's model or runtime (`workerType`). Tier 2 takes escalations
 * and ambiguous work; tier 1 follows a clearer brief. Pick the preset that
 * matches the *role* you want the agent to play; the model running it is
 * orthogonal.
 */
export const ROLE_PRESETS: Record<string, {
  specialization: string;
  domains: string[];
  role: "worker";
  tier?: number;
}> = {
  architect: {
    role: "worker",
    specialization: "architect",
    tier: 2,
    domains: ["architecture", "design", "system-design", "planning"],
  },
  writer: {
    role: "worker",
    specialization: "writer",
    tier: 2,
    domains: ["typescript", "react", "api", "implementation"],
  },
  reviewer: {
    role: "worker",
    specialization: "reviewer",
    tier: 1,
    domains: ["review", "code-quality", "pr"],
  },
  tester: {
    role: "worker",
    specialization: "tester",
    tier: 1,
    domains: ["testing", "qa", "e2e", "coverage"],
  },
  devops: {
    role: "worker",
    specialization: "devops",
    tier: 1,
    domains: ["ci", "infrastructure", "docker", "deployments"],
  },
};
