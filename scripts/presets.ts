export const ROLE_PRESETS: Record<string, {
  specialization: string;
  domains: string[];
  role: "worker";
  tier?: number;
}> = {
  // Primary agents
  claude: {
    role: "worker",
    specialization: "architect",
    tier: 2,
    domains: ["architecture", "design", "implementation", "planning"],
  },
  copilot: {
    role: "worker",
    specialization: "reviewer",
    tier: 1,
    domains: ["review", "docs", "tickets", "pr", "code-quality"],
  },

  // Specialization aliases
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
