import { useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Textarea } from "../components/ui/textarea";
import type { WebApiClient, TaskRow, AgentRow } from "../lib/api";

const STATUS_BADGE: Record<string, "default" | "blue" | "yellow" | "green" | "red" | "outline"> = {
  pending:     "outline",
  assigned:    "blue",
  in_progress: "yellow",
  completed:   "green",
  blocked:     "red",
  cancelled:   "outline",
};

const PRIORITY_BADGE: Record<string, "default" | "yellow" | "red" | "outline"> = {
  low:    "outline",
  normal: "default",
  high:   "yellow",
  urgent: "red",
};

const FILTERS = ["all", "pending", "assigned", "in_progress", "blocked", "completed"];

function TaskItem({ task, api, agents }: { task: TaskRow; api: WebApiClient; agents: AgentRow[] }) {
  const qc = useQueryClient();
  const update = useMutation({
    mutationFn: (body: { status?: string; assignedTo?: string | null }) =>
      api.updateTask(task.id, body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["tasks"] }),
  });

  const assignedAgent = agents.find((a) => a.id === task.assignedTo);
  const workers = agents.filter((a) => a.role === "worker");
  const canAssign = task.status !== "completed" && task.status !== "cancelled";

  return (
    <div className="flex items-start gap-3 rounded-lg border border-zinc-800 bg-zinc-900 p-3">
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-sm font-medium text-zinc-100 truncate">{task.title}</span>
          <Badge variant={STATUS_BADGE[task.status] ?? "default"}>{task.status.replace("_", " ")}</Badge>
          <Badge variant={PRIORITY_BADGE[task.priority] ?? "default"}>{task.priority}</Badge>
          {task.specialization && <Badge variant="blue">{task.specialization}</Badge>}
          {task.domains.map((d) => (
            <Badge key={d} variant="outline">{d}</Badge>
          ))}
        </div>
        {task.description && (
          <p className="mt-1 text-xs text-zinc-500 line-clamp-2">{task.description}</p>
        )}
        <div className="mt-1 flex items-center gap-3">
          <p className="text-xs text-zinc-600 font-mono">{task.id}</p>
          {assignedAgent && (
            <p className="text-xs text-zinc-500">→ {assignedAgent.name}</p>
          )}
        </div>
      </div>
      <div className="flex gap-1 shrink-0 items-center">
        {canAssign && workers.length > 0 && (
          <select
            value={task.assignedTo ?? ""}
            onChange={(e) => {
              const agentId = e.target.value;
              update.mutate({ status: "assigned", assignedTo: agentId || null });
            }}
            className="rounded border border-zinc-700 bg-zinc-800 text-zinc-300 text-xs px-2 py-1"
            disabled={update.isPending}
          >
            <option value="">Assign to…</option>
            {workers.map((a) => (
              <option key={a.id} value={a.id}>{a.name}</option>
            ))}
          </select>
        )}
        {task.status !== "in_progress" && task.status !== "completed" && (
          <Button size="sm" variant="outline" onClick={() => update.mutate({ status: "in_progress" })} disabled={update.isPending}>
            Start
          </Button>
        )}
        {task.status !== "completed" && (
          <Button size="sm" variant="outline" onClick={() => update.mutate({ status: "completed" })} disabled={update.isPending}>
            Done
          </Button>
        )}
        {task.status !== "blocked" && task.status !== "completed" && (
          <Button size="sm" variant="outline" className="text-zinc-400" onClick={() => update.mutate({ status: "blocked" })} disabled={update.isPending}>
            Block
          </Button>
        )}
      </div>
    </div>
  );
}

const SPECIALIZATIONS = ["reviewer", "writer", "architect", "tester", "devops"];

function NewTaskForm({ api, onClose }: { api: WebApiClient; onClose: () => void }) {
  const qc = useQueryClient();
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [specialization, setSpecialization] = useState("");
  const [domains, setDomains] = useState("");

  const create = useMutation({
    mutationFn: () => api.createTask({
      title,
      description,
      specialization: specialization || undefined,
      domains: domains ? domains.split(",").map((d) => d.trim()).filter(Boolean) : [],
    }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["tasks"] });
      onClose();
    },
  });

  return (
    <div className="rounded-lg border border-zinc-700 bg-zinc-900 p-4 space-y-3">
      <h2 className="text-sm font-semibold text-zinc-200">New task</h2>
      <Input
        placeholder="Title"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
      />
      <Textarea
        placeholder="Description"
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        rows={3}
      />
      <div className="flex gap-2 flex-wrap">
        <select
          value={specialization}
          onChange={(e) => setSpecialization(e.target.value)}
          className="rounded-md border border-zinc-700 bg-zinc-800 text-zinc-200 text-sm px-2 py-1.5 flex-1"
        >
          <option value="">Specialization (auto-route)</option>
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
      <div className="flex gap-2 justify-end">
        <Button size="sm" variant="ghost" onClick={onClose}>Cancel</Button>
        <Button
          size="sm"
          onClick={() => create.mutate()}
          disabled={!title.trim() || create.isPending}
        >
          {create.isPending ? "Creating…" : "Create task"}
        </Button>
      </div>
      {create.isError && (
        <p className="text-xs text-red-400">{(create.error as Error).message}</p>
      )}
    </div>
  );
}

export function Tasks({ api }: { api: WebApiClient }) {
  const [searchParams] = useSearchParams();
  const initialFilter = searchParams.get("status") ?? "all";
  const [filter, setFilter] = useState(initialFilter);
  const [showForm, setShowForm] = useState(false);

  const status = filter === "all" ? undefined : filter;
  const tasks = useQuery({
    queryKey: ["tasks", filter],
    queryFn: () => api.getTasks(status),
    refetchInterval: 5_000,
  });
  const agentsQuery = useQuery({
    queryKey: ["agents"],
    queryFn: () => api.getAgents(),
    refetchInterval: 30_000,
  });

  const filtered = tasks.data ?? [];
  const agents = agentsQuery.data ?? [];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <h1 className="text-xl font-semibold font-mono">Tasks</h1>
        <div className="flex items-center gap-2 flex-wrap">
          {FILTERS.map((f) => (
            <Button
              key={f}
              size="sm"
              variant={filter === f ? "default" : "ghost"}
              onClick={() => setFilter(f)}
            >
              {f.replace("_", " ")}
            </Button>
          ))}
          <Button size="sm" onClick={() => setShowForm((v) => !v)}>
            {showForm ? "Cancel" : "+ New task"}
          </Button>
        </div>
      </div>

      {showForm && <NewTaskForm api={api} onClose={() => setShowForm(false)} />}

      {tasks.isLoading && <p className="text-sm text-zinc-500">Loading…</p>}

      <div className="space-y-2">
        {filtered.map((task) => (
          <TaskItem key={task.id} task={task} api={api} agents={agents} />
        ))}
        {!tasks.isLoading && filtered.length === 0 && (
          <p className="text-sm text-zinc-500">No tasks match this filter.</p>
        )}
      </div>
    </div>
  );
}
