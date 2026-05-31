import { useState, useEffect, useRef } from "react";
import { useSearchParams } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Send } from "lucide-react";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Textarea } from "../components/ui/textarea";
import type { WebApiClient, TaskRow, AgentRow } from "../lib/api";

const STATUS_BADGE: Record<string, "default" | "blue" | "yellow" | "green" | "red" | "purple" | "outline"> = {
  proposed:             "purple",
  pending:              "outline",
  assigned:             "blue",
  in_progress:          "yellow",
  pending_verification: "purple",
  completed:            "green",
  blocked:              "red",
  cancelled:            "outline",
};

const PRIORITY_BADGE: Record<string, "default" | "yellow" | "red" | "outline"> = {
  low: "outline", normal: "default", high: "yellow", urgent: "red",
};

const FILTERS = ["all", "proposed", "pending", "assigned", "in_progress", "pending_verification", "blocked", "completed"];
const MSG_BADGE: Record<string, "default" | "green" | "yellow" | "red" | "blue" | "outline"> = {
  handoff: "blue", finding: "default", decision: "green", question: "yellow", escalation: "red", status: "outline", reply: "outline",
};

function relativeTime(iso: string): string {
  const ageMs = Date.now() - new Date(iso).getTime();
  if (ageMs < 60_000) return "just now";
  if (ageMs < 3_600_000) return `${Math.floor(ageMs / 60_000)}m ago`;
  if (ageMs < 86_400_000) return `${Math.floor(ageMs / 3_600_000)}h ago`;
  return new Date(iso).toLocaleDateString();
}

// ── Comments pane (an Issue's linked thread) ──────────────────────────────────
function Comments({ taskId, api, agents }: {
  taskId: string; api: WebApiClient; agents: AgentRow[];
}) {
  const qc = useQueryClient();
  const [draft, setDraft] = useState("");
  const endRef = useRef<HTMLDivElement>(null);
  const agentMap = new Map(agents.map((a) => [a.id, a]));

  const comments = useQuery({
    queryKey: ["comments", taskId],
    queryFn: () => api.getTaskComments(taskId),
    refetchInterval: 3_000,
  });
  const send = useMutation({
    mutationFn: () => api.postTaskComment(taskId, draft.trim()),
    onSuccess: () => {
      setDraft("");
      qc.invalidateQueries({ queryKey: ["comments", taskId] });
    },
  });

  useEffect(() => { setDraft(""); }, [taskId]);
  useEffect(() => { endRef.current?.scrollIntoView({ behavior: "smooth" }); }, [comments.data]);

  function onKey(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && draft.trim() && !send.isPending) send.mutate();
  }

  const rows = comments.data?.comments ?? [];
  return (
    <div className="border-t border-zinc-800 pt-3">
      <p className="text-xs text-zinc-600 uppercase tracking-wider mb-2">Comments</p>
      <div className="space-y-3 max-h-[340px] overflow-y-auto pr-1">
        {comments.isLoading && <p className="text-xs text-zinc-500">Loading…</p>}
        {rows.map((m) => {
          const from = agentMap.get(m.fromAgent);
          return (
            <div key={m.id} className="space-y-1">
              <div className="flex items-center gap-2 flex-wrap">
                <Badge variant={MSG_BADGE[m.type] ?? "default"}>{m.type}</Badge>
                <span className="text-xs font-medium text-zinc-300">{from?.name ?? m.fromAgent}</span>
                <span className="text-xs text-zinc-600">{relativeTime(m.createdAt)}</span>
              </div>
              <p className="text-sm text-zinc-200 whitespace-pre-wrap pl-1">{m.body}</p>
            </div>
          );
        })}
        {!comments.isLoading && rows.length === 0 && (
          <p className="text-xs text-zinc-500">No comments yet.</p>
        )}
        <div ref={endRef} />
      </div>
      <div className="mt-3 flex gap-2 items-end">
        <Textarea
          placeholder="Comment as human… (⌘↵ to send)"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKey}
          rows={2}
          className="flex-1 resize-none"
        />
        <Button size="sm" onClick={() => send.mutate()} disabled={!draft.trim() || send.isPending}>
          <Send className="h-3.5 w-3.5" />
        </Button>
      </div>
    </div>
  );
}

// ── Issue detail (header + actions + comments) ────────────────────────────────
function IssueDetail({ issue, api, agents }: { issue: TaskRow; api: WebApiClient; agents: AgentRow[] }) {
  const qc = useQueryClient();
  const invalidate = () => qc.invalidateQueries({ queryKey: ["issues"] });
  const update = useMutation({
    mutationFn: (body: { status?: string; assignedTo?: string | null }) => api.updateTask(issue.id, body),
    onSuccess: invalidate,
  });
  const review = useMutation({
    mutationFn: (decision: "approve" | "reject") => api.submitReview(issue.id, { decision }),
    onSuccess: invalidate,
  });
  const commit = useMutation({
    mutationFn: (body: { decision?: "commit" | "reject"; assignedTo?: string }) => api.commitTask(issue.id, body),
    onSuccess: invalidate,
  });

  const workers = agents.filter((a) => a.role === "worker");
  const assignee = agents.find((a) => a.id === issue.assignedTo);
  const isProposed = issue.status === "proposed";
  const isAwaitingReview = issue.status === "pending_verification" && issue.verifyKind === "reviewer_agent";
  const reviewer = isAwaitingReview ? agents.find((a) => a.id === issue.verifyReviewerId) : undefined;
  const canAssign = !["completed", "cancelled", "proposed"].includes(issue.status);
  const suggested = (issue.metadata?.proposal as { suggestedAssignee?: string } | undefined)?.suggestedAssignee;
  const [commitTo, setCommitTo] = useState<string>("@auto");

  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900">
      <div className="px-4 py-3 border-b border-zinc-800">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-sm font-semibold text-zinc-100">{issue.title}</span>
          <Badge variant={STATUS_BADGE[issue.status] ?? "default"}>{issue.status.replace(/_/g, " ")}</Badge>
          <Badge variant={PRIORITY_BADGE[issue.priority] ?? "default"}>{issue.priority}</Badge>
          {issue.specialization && <Badge variant="blue">{issue.specialization}</Badge>}
          {issue.domains.map((d) => <Badge key={d} variant="outline">{d}</Badge>)}
        </div>
        <div className="mt-1 flex items-center gap-3 flex-wrap text-xs text-zinc-600">
          <span className="font-mono">{issue.id}</span>
          {assignee && <span className="text-zinc-500">→ {assignee.name}</span>}
          {reviewer && <span className="text-purple-300">review by {reviewer.name}</span>}
          {issue.epicId && <span className="text-zinc-500">epic: <span className="font-mono">{issue.epicId}</span></span>}
        </div>
      </div>

      {issue.description && (
        <div className="px-4 py-3 border-b border-zinc-800">
          <p className="text-sm text-zinc-300 whitespace-pre-wrap">{issue.description}</p>
        </div>
      )}

      {/* Actions */}
      <div className="px-4 py-3 border-b border-zinc-800 flex flex-wrap gap-2 items-center">
        {isProposed ? (
          <>
            <span className="text-xs text-zinc-500">
              Proposal{suggested ? ` (suggests ${agents.find((a) => a.id === suggested)?.name ?? suggested})` : ""} —
            </span>
            <select
              value={commitTo}
              onChange={(e) => setCommitTo(e.target.value)}
              className="rounded border border-zinc-700 bg-zinc-800 text-zinc-300 text-xs px-2 py-1"
            >
              <option value="@auto">@auto (router)</option>
              {workers.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
            <Button size="sm" onClick={() => commit.mutate({ decision: "commit", assignedTo: commitTo })} disabled={commit.isPending}>
              Commit
            </Button>
            <Button size="sm" variant="outline" className="border-red-800 text-red-300 hover:bg-red-950"
              onClick={() => commit.mutate({ decision: "reject" })} disabled={commit.isPending}>
              Reject
            </Button>
          </>
        ) : isAwaitingReview ? (
          <>
            <Button size="sm" variant="outline" className="border-green-800 text-green-300 hover:bg-green-950"
              onClick={() => review.mutate("approve")} disabled={review.isPending}>Approve</Button>
            <Button size="sm" variant="outline" className="border-red-800 text-red-300 hover:bg-red-950"
              onClick={() => review.mutate("reject")} disabled={review.isPending}>Reject</Button>
          </>
        ) : (
          <>
            {canAssign && workers.length > 0 && (
              <select
                value={issue.assignedTo ?? ""}
                onChange={(e) => update.mutate({ status: "assigned", assignedTo: e.target.value || null })}
                className="rounded border border-zinc-700 bg-zinc-800 text-zinc-300 text-xs px-2 py-1"
                disabled={update.isPending}
              >
                <option value="">Assign to…</option>
                {workers.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
              </select>
            )}
            {issue.status !== "in_progress" && issue.status !== "completed" && (
              <Button size="sm" variant="outline" onClick={() => update.mutate({ status: "in_progress" })} disabled={update.isPending}>Start</Button>
            )}
            {issue.status !== "completed" && (
              <Button size="sm" variant="outline" onClick={() => update.mutate({ status: "completed" })} disabled={update.isPending}>Done</Button>
            )}
            {issue.status !== "blocked" && issue.status !== "completed" && (
              <Button size="sm" variant="outline" className="text-zinc-400" onClick={() => update.mutate({ status: "blocked" })} disabled={update.isPending}>Block</Button>
            )}
          </>
        )}
      </div>

      <div className="px-4 py-3">
        <Comments taskId={issue.id} api={api} agents={agents} />
      </div>
    </div>
  );
}

const SPECIALIZATIONS = ["reviewer", "writer", "architect", "tester", "devops"];

function NewIssueForm({ api, onClose }: { api: WebApiClient; onClose: () => void }) {
  const qc = useQueryClient();
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [specialization, setSpecialization] = useState("");
  const [domains, setDomains] = useState("");

  const create = useMutation({
    mutationFn: () => api.createTask({
      title, description,
      specialization: specialization || undefined,
      domains: domains ? domains.split(",").map((d) => d.trim()).filter(Boolean) : [],
    }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["issues"] }); onClose(); },
  });

  return (
    <div className="rounded-lg border border-zinc-700 bg-zinc-900 p-4 space-y-3">
      <h2 className="text-sm font-semibold text-zinc-200">New issue</h2>
      <Input placeholder="Title" value={title} onChange={(e) => setTitle(e.target.value)} />
      <Textarea placeholder="Description" value={description} onChange={(e) => setDescription(e.target.value)} rows={3} />
      <div className="flex gap-2 flex-wrap">
        <select value={specialization} onChange={(e) => setSpecialization(e.target.value)}
          className="rounded-md border border-zinc-700 bg-zinc-800 text-zinc-200 text-sm px-2 py-1.5 flex-1">
          <option value="">Specialization (auto-route)</option>
          {SPECIALIZATIONS.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
        <Input className="flex-1" placeholder="Domains (comma-separated)" value={domains} onChange={(e) => setDomains(e.target.value)} />
      </div>
      <div className="flex gap-2 justify-end">
        <Button size="sm" variant="ghost" onClick={onClose}>Cancel</Button>
        <Button size="sm" onClick={() => create.mutate()} disabled={!title.trim() || create.isPending}>
          {create.isPending ? "Creating…" : "Create issue"}
        </Button>
      </div>
      {create.isError && <p className="text-xs text-red-400">{(create.error as Error).message}</p>}
    </div>
  );
}

export function Issues({ api }: { api: WebApiClient }) {
  const [searchParams] = useSearchParams();
  const [filter, setFilter] = useState(searchParams.get("status") ?? "all");
  const [showForm, setShowForm] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const status = filter === "all" ? undefined : filter;
  const issues = useQuery({
    queryKey: ["issues", filter],
    queryFn: () => api.getTasks(status),
    refetchInterval: 5_000,
  });
  const agentsQuery = useQuery({ queryKey: ["agents"], queryFn: () => api.getAgents(), refetchInterval: 30_000 });

  const rows = issues.data ?? [];
  const agents = agentsQuery.data ?? [];
  const selected = rows.find((t) => t.id === selectedId) ?? null;

  useEffect(() => {
    if (selectedId && !rows.some((t) => t.id === selectedId)) setSelectedId(null);
  }, [rows, selectedId]);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <h1 className="text-xl font-semibold font-mono">Issues</h1>
        <div className="flex items-center gap-2 flex-wrap">
          {FILTERS.map((f) => (
            <Button key={f} size="sm" variant={filter === f ? "default" : "ghost"} onClick={() => setFilter(f)}>
              {f.replace(/_/g, " ")}
            </Button>
          ))}
          <Button size="sm" onClick={() => setShowForm((v) => !v)}>{showForm ? "Cancel" : "+ New issue"}</Button>
        </div>
      </div>

      {showForm && <NewIssueForm api={api} onClose={() => setShowForm(false)} />}
      {issues.isLoading && <p className="text-sm text-zinc-500">Loading…</p>}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        {/* Issue list */}
        <div className="space-y-1.5">
          {rows.map((t) => {
            const assignee = agents.find((a) => a.id === t.assignedTo);
            return (
              <button
                key={t.id}
                onClick={() => setSelectedId(t.id)}
                className={`w-full text-left rounded-lg border px-3 py-2.5 transition-colors ${
                  selectedId === t.id
                    ? "border-zinc-500 bg-zinc-800"
                    : "border-zinc-800 bg-zinc-900 hover:border-zinc-700"
                }`}
              >
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium text-zinc-100 truncate flex-1">{t.title}</span>
                  <Badge variant={STATUS_BADGE[t.status] ?? "default"}>{t.status.replace(/_/g, " ")}</Badge>
                </div>
                <div className="mt-0.5 flex items-center gap-2 text-xs text-zinc-600">
                  <Badge variant={PRIORITY_BADGE[t.priority] ?? "default"}>{t.priority}</Badge>
                  {assignee && <span>→ {assignee.name}</span>}
                </div>
              </button>
            );
          })}
          {!issues.isLoading && rows.length === 0 && (
            <p className="text-sm text-zinc-500">No issues match this filter.</p>
          )}
        </div>

        {/* Issue detail */}
        <div className="lg:col-span-2">
          {selected ? (
            <IssueDetail key={selected.id} issue={selected} api={api} agents={agents} />
          ) : (
            <div className="rounded-lg border border-dashed border-zinc-800 px-4 py-8 text-center">
              <p className="text-sm text-zinc-500">Select an issue to view details and comments</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
