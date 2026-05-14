import { homedir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";

export interface AgentClaim {
  agentId: string;
  agentName: string;
  workingDir: string;
  apiUrl: string;
  tokenRef: string;
}

export interface AgentsState {
  agents: AgentClaim[];
}

function statePath(): string {
  if (process.env.RELAI_AGENTS_STATE) return process.env.RELAI_AGENTS_STATE;
  return join(homedir(), ".config", "relai", "agents.json");
}

export function agentsStatePath(): string {
  return statePath();
}

export function readAgentsState(): AgentsState {
  const p = statePath();
  if (!existsSync(p)) return { agents: [] };
  try {
    const raw = JSON.parse(readFileSync(p, "utf-8")) as AgentsState;
    if (!raw || !Array.isArray(raw.agents)) return { agents: [] };
    return raw;
  } catch {
    return { agents: [] };
  }
}

function writeAgentsState(state: AgentsState): void {
  const p = statePath();
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(state, null, 2));
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex").slice(0, 16);
}

export class WorkingDirCollisionError extends Error {
  constructor(
    public existing: AgentClaim,
    public newAgentId: string,
    public repoName: string,
  ) {
    super(
      `Agent ${existing.agentName} (${existing.agentId}) is already using ${existing.workingDir}.`,
    );
    this.name = "WorkingDirCollisionError";
  }
}

export function claimWorkingDir(claim: AgentClaim): AgentsState {
  const absDir = resolve(claim.workingDir);
  const state = readAgentsState();

  const existing = state.agents.find((a) => resolve(a.workingDir) === absDir);
  if (existing && existing.agentId !== claim.agentId) {
    throw new WorkingDirCollisionError(existing, claim.agentId, "");
  }

  const next: AgentClaim = { ...claim, workingDir: absDir };
  state.agents = state.agents.filter((a) => a.agentId !== claim.agentId);
  state.agents.push(next);
  writeAgentsState(state);
  return state;
}
