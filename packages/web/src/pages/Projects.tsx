import { useState } from "react";
import { Link } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, Trash2, Cpu, User } from "lucide-react";
import { Card, CardContent } from "../components/ui/card";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Badge } from "../components/ui/badge";
import { saveConfig } from "../lib/config";
import type { WebApiClient, ProjectRow } from "../lib/api";

// "@auto" → routing scheduler picks an agent; null → tasks stay unassigned by default.
type DefaultAssignee = "@auto" | null;

function DefaultAssigneeCard({
  mode,
  selected,
  onSelect,
}: {
  mode: DefaultAssignee;
  selected: boolean;
  onSelect: () => void;
}) {
  const isAuto = mode === "@auto";
  return (
    <button
      type="button"
      onClick={onSelect}
      className={`flex-1 rounded-lg border p-3 text-left transition-colors ${
        selected
          ? "border-violet-500 bg-violet-950/30"
          : "border-zinc-700 bg-zinc-800/50 hover:border-zinc-600"
      }`}
    >
      <div className="flex items-center gap-2 mb-1.5">
        {isAuto
          ? <Cpu className="h-4 w-4 text-violet-400" />
          : <User className="h-4 w-4 text-zinc-400" />}
        <span className="text-sm font-medium text-zinc-100">
          {isAuto ? "Auto-route" : "Manual"}
        </span>
      </div>
      <p className="text-xs text-zinc-500 leading-relaxed">
        {isAuto
          ? "New tasks without an explicit assignee are picked up by the routing scheduler and assigned to a worker."
          : "Tasks stay unassigned until you (or another agent) pick an assignee. Per-task @auto still works."}
      </p>
    </button>
  );
}

function PostCreationGuide({
  project,
  onDone,
}: {
  project: ProjectRow;
  onDone: () => void;
}) {
  const isAutomated = project.defaultAssignee === "@auto";

  return (
    <div className="rounded-lg border border-zinc-700 bg-zinc-900 p-4 space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-zinc-200">Project created</h2>
        <span className="text-xs text-zinc-500 font-mono">{project.id}</span>
      </div>

      <p className="text-sm text-zinc-400">
        <span className="text-zinc-200 font-medium">{project.name}</span> is ready.
        Here's what to do next:
      </p>

      <ol className="space-y-3">
        <li className="flex gap-3">
          <span className="text-xs font-mono text-violet-400 shrink-0 mt-0.5">01</span>
          <div>
            <p className="text-sm text-zinc-200">Register worker agents</p>
            <p className="text-xs text-zinc-500 mt-0.5">
              Go to <Link to="/agents" className="text-zinc-300 underline underline-offset-2" onClick={onDone}>Agents</Link> and register
              the Claude Code or Copilot sessions that will handle tasks.
            </p>
          </div>
        </li>

        {isAutomated ? (
          <li className="flex gap-3">
            <span className="text-xs font-mono text-violet-400 shrink-0 mt-0.5">02</span>
            <div>
              <p className="text-sm text-zinc-200">Start the routing daemon</p>
              <p className="text-xs text-zinc-500 mt-0.5">
                Run the orchestrator in a terminal — it will pick up pending tasks and route them automatically.
              </p>
              <pre className="mt-1.5 text-xs text-zinc-300 bg-zinc-950 border border-zinc-800 rounded px-2.5 py-1.5 font-mono">
                pnpm --filter @relai/orchestrator dev
              </pre>
            </div>
          </li>
        ) : (
          <li className="flex gap-3">
            <span className="text-xs font-mono text-violet-400 shrink-0 mt-0.5">02</span>
            <div>
              <p className="text-sm text-zinc-200">Assign tasks manually</p>
              <p className="text-xs text-zinc-500 mt-0.5">
                Create tasks on the <Link to="/tasks" className="text-zinc-300 underline underline-offset-2" onClick={onDone}>Tasks</Link> page
                and use the "Assign to…" dropdown to route them to workers.
              </p>
            </div>
          </li>
        )}

        <li className="flex gap-3">
          <span className="text-xs font-mono text-violet-400 shrink-0 mt-0.5">{isAutomated ? "03" : "03"}</span>
          <div>
            <p className="text-sm text-zinc-200">Create tasks</p>
            <p className="text-xs text-zinc-500 mt-0.5">
              Add tasks from the <Link to="/tasks" className="text-zinc-300 underline underline-offset-2" onClick={onDone}>Tasks</Link> page.
              Workers will pick them up {isAutomated ? "automatically" : "once assigned"}.
            </p>
          </div>
        </li>
      </ol>

      <div className="flex justify-end">
        <Button size="sm" onClick={onDone}>Got it</Button>
      </div>
    </div>
  );
}

function CreateProjectForm({ api, onCreated }: { api: WebApiClient; onCreated: (p: ProjectRow) => void }) {
  const [name, setName]                       = useState("");
  const [desc, setDesc]                       = useState("");
  const [defaultAssignee, setDefaultAssignee] = useState<DefaultAssignee>("@auto");
  const [open, setOpen]                       = useState(false);
  const qc = useQueryClient();

  const create = useMutation({
    mutationFn: () => api.createProject(
      name.trim(),
      desc.trim() || undefined,
      defaultAssignee ?? undefined,
    ),
    onSuccess: (p) => {
      qc.invalidateQueries({ queryKey: ["projects"] });
      setName(""); setDesc(""); setOpen(false);
      onCreated(p);
    },
  });

  if (!open) {
    return (
      <Button size="sm" onClick={() => setOpen(true)}>+ New project</Button>
    );
  }

  return (
    <form
      className="rounded-lg border border-zinc-700 bg-zinc-900 p-4 space-y-4"
      onSubmit={(e) => { e.preventDefault(); create.mutate(); }}
    >
      <h2 className="text-sm font-semibold text-zinc-200">New project</h2>

      <div className="space-y-2">
        <Input
          placeholder="Name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
          autoFocus
        />
        <Input
          placeholder="Description (optional)"
          value={desc}
          onChange={(e) => setDesc(e.target.value)}
        />
      </div>

      <div className="space-y-2">
        <p className="text-xs text-zinc-500 uppercase tracking-wider">Default assignee</p>
        <div className="flex gap-2">
          <DefaultAssigneeCard mode="@auto" selected={defaultAssignee === "@auto"} onSelect={() => setDefaultAssignee("@auto")} />
          <DefaultAssigneeCard mode={null}    selected={defaultAssignee === null}    onSelect={() => setDefaultAssignee(null)} />
        </div>
      </div>

      {create.isError && (
        <p className="text-xs text-red-400">{(create.error as Error).message}</p>
      )}
      <div className="flex gap-2 justify-end">
        <Button type="button" size="sm" variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
        <Button type="submit" size="sm" disabled={create.isPending || !name.trim()}>
          {create.isPending ? "Creating…" : "Create project"}
        </Button>
      </div>
    </form>
  );
}

export function Projects({
  api,
  onSwitch,
}: {
  api: WebApiClient;
  onSwitch: (projectId: string) => void;
}) {
  const qc = useQueryClient();
  const [newProject, setNewProject] = useState<ProjectRow | null>(null);

  const projects = useQuery({
    queryKey: ["projects"],
    queryFn: () => api.getProjects(),
    refetchInterval: 10_000,
  });

  const del = useMutation({
    mutationFn: (id: string) => api.deleteProject(id),
    onSuccess: (_, id) => {
      qc.invalidateQueries({ queryKey: ["projects"] });
      if (id === api.projectId) onSwitch("");
    },
  });

  function handleSwitch(p: ProjectRow) {
    saveConfig({ apiUrl: api.apiUrl, apiSecret: api.apiSecret, projectId: p.id });
    onSwitch(p.id);
  }

  function handleCreated(p: ProjectRow) {
    handleSwitch(p);
    setNewProject(p);
  }

  if (newProject) {
    return (
      <div className="space-y-4">
        <h1 className="text-xl font-semibold font-mono">Projects</h1>
        <PostCreationGuide project={newProject} onDone={() => setNewProject(null)} />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold font-mono">Projects</h1>
        <CreateProjectForm api={api} onCreated={handleCreated} />
      </div>

      {projects.isLoading && <p className="text-sm text-zinc-500">Loading…</p>}

      <div className="space-y-2">
        {(projects.data ?? []).map((p) => (
          <Card key={p.id} className={p.id === api.projectId ? "border-zinc-600" : ""}>
            <CardContent className="py-3 px-4 flex items-center gap-3">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  {p.id === api.projectId && (
                    <CheckCircle2 className="h-3.5 w-3.5 text-green-400 shrink-0" />
                  )}
                  <span className="text-sm font-medium text-zinc-100">{p.name}</span>
                  {p.defaultAssignee && (
                    <Badge variant={p.defaultAssignee === "@auto" ? "blue" : "outline"}>
                      {p.defaultAssignee === "@auto" ? "auto-route" : `→ ${p.defaultAssignee}`}
                    </Badge>
                  )}
                </div>
                {p.description && (
                  <p className="text-xs text-zinc-500 mt-0.5">{p.description}</p>
                )}
                <p className="text-xs text-zinc-700 font-mono mt-0.5">{p.id}</p>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                {p.id !== api.projectId && (
                  <Button size="sm" variant="outline" onClick={() => handleSwitch(p)}>
                    Switch
                  </Button>
                )}
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => del.mutate(p.id)}
                  disabled={del.isPending}
                  className="text-zinc-500 hover:text-red-400"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
            </CardContent>
          </Card>
        ))}
        {!projects.isLoading && projects.data?.length === 0 && (
          <p className="text-sm text-zinc-500">No projects yet.</p>
        )}
      </div>
    </div>
  );
}
