import { homedir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { legacyHomePath, readableFrom, retireLegacy } from "../config.js";

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

const stateOverridden = () => Boolean(process.env.PITBOSS_AGENTS_STATE || process.env.RELAI_AGENTS_STATE);

function statePath(): string {
  return process.env.PITBOSS_AGENTS_STATE || process.env.RELAI_AGENTS_STATE || join(homedir(), ".config", "pitboss", "agents.json");
}

export function agentsStatePath(): string {
  return statePath();
}

export function readAgentsState(): AgentsState {
  const p = readableFrom(statePath(), legacyHomePath("agents.json"), stateOverridden());
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
  retireLegacy(legacyHomePath("agents.json"), stateOverridden());
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
