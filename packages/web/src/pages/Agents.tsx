import { useState } from "react";
import { Link } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, Circle, Trash2, Copy, Check } from "lucide-react";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import type { WebApiClient, AgentRow } from "../lib/api";


const SPECIALIZATIONS = ["architect", "writer", "reviewer", "tester", "devops"];
const WORKER_TYPES = ["claude", "copilot", "cursor", "windsurf", "gemini", "gpt", "mcp", "human"] as const;
type WorkerType = typeof WORKER_TYPES[number];

function AgentCard({ agent, now, api }: { agent: AgentRow; now: number; api: WebApiClient }) {
  const qc = useQueryClient();
  const online = now - new Date(agent.lastSeenAt).getTime() < 10 * 60 * 1000;
  const lastSeen = new Date(agent.lastSeenAt);
  const ageMs = now - lastSeen.getTime();

  const ageLabel = ageMs < 60_000
    ? "just now"
    : ageMs < 3_600_000
    ? `${Math.floor(ageMs / 60_000)}m ago`
    : ageMs < 86_400_000
    ? `${Math.floor(ageMs / 3_600_000)}h ago`
    : lastSeen.toLocaleDateString();

  const remove = useMutation({
    mutationFn: () => api.deleteAgent(agent.id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["agents"] }),
  });

  return (
    <div className="flex items-center gap-3 rounded-lg border border-zinc-800 bg-zinc-900 px-4 py-3">
      <div className="shrink-0">
        {online
          ? <CheckCircle2 className="h-4 w-4 text-green-400" />
          : <Circle className="h-4 w-4 text-zinc-600" />}
      </div>

      <div className="min-w-0 w-36 shrink-0">
        <span className="text-sm font-medium text-zinc-100 truncate">{agent.name}</span>
        <p className="text-xs text-zinc-600 font-mono truncate" title={agent.id}>{agent.id}</p>
        {agent.repoPath && (
          <p className="text-xs text-zinc-600 font-mono truncate" title={agent.repoPath}>
            {agent.repoPath.split("/").pop()}
          </p>
        )}
      </div>

      <div className="flex items-center gap-1.5 w-40 shrink-0 flex-wrap">
        {agent.workerType && <Badge variant="outline">{agent.workerType}</Badge>}
        {agent.specialization && <Badge variant="blue">{agent.specialization}</Badge>}
      </div>

      <div className="flex-1 flex flex-wrap gap-1 min-w-0">
        {agent.domains.length > 0
          ? agent.domains.map((d) => <Badge key={d} variant="outline">{d}</Badge>)
          : <span className="text-xs text-zinc-600">—</span>}
      </div>

      <span className={`text-xs shrink-0 ${online ? "text-green-400" : "text-zinc-500"}`}>
        {online ? "online" : ageLabel}
      </span>

      <Button
        size="sm"
        variant="ghost"
        className="shrink-0 text-zinc-600 hover:text-red-400"
        onClick={() => remove.mutate()}
        disabled={remove.isPending || online}
        title={online ? "Can't delete an online agent" : "Delete agent"}
      >
        <Trash2 className="h-3.5 w-3.5" />
      </Button>
    </div>
  );
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  function copy() {
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }
  return (
    <button
      onClick={copy}
      className="shrink-0 text-zinc-500 hover:text-zinc-200 transition-colors"
      title="Copy to clipboard"
    >
      {copied ? <Check className="h-3.5 w-3.5 text-green-400" /> : <Copy className="h-3.5 w-3.5" />}
    </button>
  );
}

function McpJsonBlock({ api, agent }: { api: WebApiClient; agent: AgentRow }) {
  const mcpBlock = JSON.stringify({
    mcpServers: {
      relai: {
        command: "node",
        args: ["/path/to/relai/packages/mcp-server/dist/index.js"],
        env: {
          API_URL: api.apiUrl,
          API_SECRET: api.apiSecret,
          AGENT_ID: agent.id,
          PROJECT_ID: api.projectId,
        },
      },
    },
  }, null, 2);

  return (
    <div className="space-y-1">
      <p className="text-xs text-zinc-500 uppercase tracking-wider">Add to .mcp.json in your project root</p>
      <p className="text-xs text-zinc-500">Replace <code className="text-zinc-400">/path/to/relai</code> with the absolute path to your Relai clone.</p>
      <div className="flex gap-2 items-start rounded-md bg-zinc-950 border border-zinc-800 p-3">
        <pre className="flex-1 text-xs text-zinc-300 font-mono whitespace-pre overflow-x-auto">{mcpBlock}</pre>
        <CopyButton text={mcpBlock} />
      </div>
    </div>
  );
}

function SetupInstructions({ agent, api }: { agent: AgentRow; api: WebApiClient }) {
  const repo = agent.repoPath ?? "/path/to/your/repo";

  const workerCmd = [
    `API_SECRET=${api.apiSecret}`,
    `PROJECT_ID=${api.projectId}`,
    `pnpm start-worker ${agent.specialization ?? "claude"} \\`,
    `  --name ${agent.name} \\`,
    `  --repo ${repo}`,
  ].join("\n");

  return (
    <div className="rounded-lg border border-zinc-700 bg-zinc-900 p-4 space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-zinc-200">Agent registered</h3>
        <span className="text-xs text-zinc-500 font-mono">{agent.id}</span>
      </div>

      {agent.workerType === "human" && (
        <p className="text-sm text-zinc-400">
          This agent represents a human team member. Tasks assigned to <span className="text-zinc-200 font-medium">{agent.name}</span> will
          appear in their task queue in the UI — no further setup needed.
        </p>
      )}

      {agent.workerType === "claude" && (
        <>
          <div className="space-y-1">
            <p className="text-xs text-zinc-500 uppercase tracking-wider">Autonomous worker — run from the Relai directory</p>
            <div className="flex gap-2 items-start rounded-md bg-zinc-950 border border-zinc-800 p-3">
              <pre className="flex-1 text-xs text-zinc-300 font-mono whitespace-pre overflow-x-auto">{workerCmd}</pre>
              <CopyButton text={workerCmd} />
            </div>
          </div>
          <div className="space-y-1">
            <p className="text-xs text-zinc-500 uppercase tracking-wider">Interactive session — optional</p>
            <McpJsonBlock api={api} agent={agent} />
          </div>
        </>
      )}

      {agent.workerType !== "human" && agent.workerType !== "claude" && (
        <McpJsonBlock api={api} agent={agent} />
      )}
    </div>
  );
}

function AddAgentForm({ api, hasOrchestrator, onClose }: { api: WebApiClient; hasOrchestrator: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const [name, setName] = useState("");
  const [role, setRole] = useState<"orchestrator" | "worker">("worker");
  const [tier, setTier] = useState<"" | "1" | "2">("");
  const [workerType, setWorkerType] = useState<WorkerType>("claude");
  const [specialization, setSpecialization] = useState("");
  const [domains, setDomains] = useState("");
  const [repoPath, setRepoPath] = useState("");
  const [created, setCreated] = useState<AgentRow | null>(null);

  const create = useMutation({
    mutationFn: () => api.createAgent({
      name: name.trim(),
      role,
      tier: role === "worker" && tier ? Number(tier) : undefined,
      workerType,
      specialization: specialization || undefined,
      domains: domains ? domains.split(",").map((d) => d.trim()).filter(Boolean) : [],
      repoPath: workerType !== "human" ? repoPath.trim() || undefined : undefined,
    }),
    onSuccess: (agent) => {
      qc.invalidateQueries({ queryKey: ["agents"] });
      setCreated(agent);
    },
  });

  if (created) {
    return (
      <div className="space-y-3">
        <SetupInstructions agent={created} api={api} />
        <div className="flex justify-end">
          <Button size="sm" variant="outline" onClick={onClose}>Done</Button>
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-zinc-700 bg-zinc-900 p-4 space-y-3">
      <h2 className="text-sm font-semibold text-zinc-200">Register new agent</h2>
      <div className="flex gap-2">
        <Input
          className="flex-1"
          placeholder="Agent name (e.g. alice-writer)"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <select
          value={workerType}
          onChange={(e) => setWorkerType(e.target.value as WorkerType)}
          className="rounded-md border border-zinc-700 bg-zinc-800 text-zinc-200 text-sm px-2 py-1.5"
        >
          {WORKER_TYPES.map((t) => (
            <option key={t} value={t}>{t}</option>
          ))}
        </select>
      </div>

      <div className="space-y-1">
        <div className="flex gap-2">
          <select
            value={role}
            onChange={(e) => setRole(e.target.value as "orchestrator" | "worker")}
            className="rounded-md border border-zinc-700 bg-zinc-800 text-zinc-200 text-sm px-2 py-1.5 flex-1"
          >
            <option value="worker">Worker — executes assigned tasks</option>
            <option value="orchestrator">Orchestrator — drives the project, receives escalations</option>
          </select>
          {role === "worker" && (
            <select
              value={tier}
              onChange={(e) => setTier(e.target.value as "" | "1" | "2")}
              className="rounded-md border border-zinc-700 bg-zinc-800 text-zinc-200 text-sm px-2 py-1.5"
              title="Tier 2 workers receive escalations from tier 1. Leave untiered for general workers."
            >
              <option value="">Untiered</option>
              <option value="1">Tier 1 — clear-brief</option>
              <option value="2">Tier 2 — takes escalations</option>
            </select>
          )}
        </div>
        <p className="text-xs text-zinc-500">
          {role === "orchestrator"
            ? hasOrchestrator
              ? "A project already has an orchestrator. Most teams want exactly one."
              : "Authors shell verifiers, owns @auto routing, fields escalations and broadcasts decisions."
            : "Workers execute tasks. Tier 2 workers receive escalations from tier 1; leave untiered for general roles."}
        </p>
      </div>

      {workerType !== "human" && (
        <Input
          placeholder="Repo path (e.g. /Users/alice/projects/my-app)"
          value={repoPath}
          onChange={(e) => setRepoPath(e.target.value)}
        />
      )}
      <div className="space-y-1">
        <div className="flex gap-2">
          <select
            value={specialization}
            onChange={(e) => setSpecialization(e.target.value)}
            className="rounded-md border border-zinc-700 bg-zinc-800 text-zinc-200 text-sm px-2 py-1.5 flex-1"
          >
            <option value="">Specialization (optional)</option>
            {SPECIALIZATIONS.map((s) => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>
          <Input
            className="flex-1"
            placeholder="Domains (comma-separated)"
            value={domains}
            onChange={(e) => setDomains(e.target.value)}
          />
        </div>
        <p className="text-xs text-zinc-500">
          Specialization shapes routing. <code className="text-zinc-400">reviewer</code> is required to use reviewer-agent verifiers; <code className="text-zinc-400">architect</code> is the fallback target for escalations when no tier-2 worker is online.
        </p>
      </div>
      <div className="flex gap-2 justify-end">
        <Button size="sm" variant="ghost" onClick={onClose}>Cancel</Button>
        <Button
          size="sm"
          onClick={() => create.mutate()}
          disabled={!name.trim() || create.isPending}
        >
          {create.isPending ? "Registering…" : "Register agent"}
        </Button>
      </div>
      {create.isError && (
        <p className="text-xs text-red-400">{(create.error as Error).message}</p>
      )}
    </div>
  );
}

function TeamComposition({ agents }: { agents: AgentRow[] }) {
  if (agents.length === 0) return null;

  const orchestrators = agents.filter((a) => a.role === "orchestrator").length;
  const workers       = agents.filter((a) => a.role === "worker");
  const bySpec        = new Map<string, number>();
  for (const w of workers) {
    const s = w.specialization ?? "untyped";
    bySpec.set(s, (bySpec.get(s) ?? 0) + 1);
  }
  const tier2 = workers.filter((a) => a.tier === 2).length;

  const gaps: string[] = [];
  if (orchestrators === 0) gaps.push("no orchestrator — routing and escalations won't work");
  if (!bySpec.has("reviewer")) gaps.push("no reviewer — reviewer-agent verifiers unavailable");
  if (!bySpec.has("architect") && tier2 === 0) gaps.push("no architect or tier-2 worker — escalations have no fallback");

  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 px-4 py-3 space-y-1">
      <p className="text-xs text-zinc-500 uppercase tracking-wider">Team composition</p>
      <p className="text-sm text-zinc-300">
        {orchestrators} orchestrator{orchestrators === 1 ? "" : "s"}, {workers.length} worker{workers.length === 1 ? "" : "s"}
        {bySpec.size > 0 && (
          <> (<span className="text-zinc-400">
            {[...bySpec.entries()].map(([s, n]) => `${n} ${s}`).join(", ")}
          </span>)</>
        )}
      </p>
      {gaps.length > 0 && (
        <ul className="text-xs text-amber-400/80 space-y-0.5">
          {gaps.map((g) => <li key={g}>• {g}</li>)}
        </ul>
      )}
    </div>
  );
}

export function Agents({ api }: { api: WebApiClient }) {
  const now = Date.now();
  const [showForm, setShowForm] = useState(false);

  const agents = useQuery({
    queryKey: ["agents"],
    queryFn:  () => api.getAgents(),
    refetchInterval: 15_000,
  });

  const data    = agents.data ?? [];
  const lead    = data.filter((a) => a.role === "orchestrator");
  const workers = data.filter((a) => a.role === "worker");
  const isOnline = (a: AgentRow) => now - new Date(a.lastSeenAt).getTime() < 10 * 60 * 1000;
  const onlineWorkers  = workers.filter(isOnline);
  const offlineWorkers = workers.filter((a) => !isOnline(a));

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold font-mono">Agents</h1>
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-3 text-sm text-zinc-500">
            <span><span className="text-green-400 font-medium">{onlineWorkers.length}</span> online</span>
            <span><span className="text-zinc-400 font-medium">{offlineWorkers.length}</span> offline</span>
          </div>
          <Button size="sm" onClick={() => setShowForm((v) => !v)}>
            {showForm ? "Cancel" : "+ Add agent"}
          </Button>
        </div>
      </div>

      {showForm && (
        <AddAgentForm
          api={api}
          hasOrchestrator={lead.length > 0}
          onClose={() => setShowForm(false)}
        />
      )}

      <TeamComposition agents={data} />

      {agents.isLoading && <p className="text-sm text-zinc-500">Loading…</p>}

      {/* Lead section */}
      <div className="space-y-2">
        <p className="text-xs text-zinc-500 uppercase tracking-wider">Lead</p>
        {lead.length === 0 && !agents.isLoading && (
          <div className="rounded-lg border border-dashed border-zinc-700 px-4 py-3 text-sm text-zinc-500">
            No lead agent running.{" "}
            <span className="text-zinc-400">
              Start the routing daemon (<code className="text-zinc-300">pnpm --filter @getrelai/orchestrator dev</code>)
              or <Link to="/tasks" className="text-zinc-300 underline underline-offset-2">do this manually</Link>.
            </span>
          </div>
        )}
        {lead.map((agent) => {
          const online = isOnline(agent);
          return (
            <div key={agent.id} className="flex items-center gap-3 rounded-lg border border-zinc-700 bg-zinc-900 px-4 py-3">
              <div className="shrink-0">
                {online
                  ? <CheckCircle2 className="h-4 w-4 text-green-400" />
                  : <Circle className="h-4 w-4 text-zinc-600" />}
              </div>
              <div className="min-w-0 flex-1">
                <span className="text-sm font-medium text-zinc-100">{agent.name}</span>
                <p className="text-xs text-zinc-600 font-mono truncate">{agent.id}</p>
              </div>
              {agent.specialization && <Badge variant="blue">{agent.specialization}</Badge>}
              <span className={`text-xs shrink-0 ${online ? "text-green-400" : "text-zinc-500"}`}>
                {online ? "online" : "offline"}
              </span>
            </div>
          );
        })}
      </div>

      {/* Workers section */}
      <div className="space-y-2">
        {lead.length > 0 && <p className="text-xs text-zinc-500 uppercase tracking-wider">Workers</p>}
        {[...onlineWorkers, ...offlineWorkers].map((agent) => (
          <AgentCard key={agent.id} agent={agent} now={now} api={api} />
        ))}
        {!agents.isLoading && workers.length === 0 && (
          <p className="text-sm text-zinc-500">No workers registered yet.</p>
        )}
      </div>
    </div>
  );
}
