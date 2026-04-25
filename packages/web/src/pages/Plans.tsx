import { useState, useEffect, useRef } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Send, CheckCheck, Trash2 } from "lucide-react";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Textarea } from "../components/ui/textarea";
import type { WebApiClient, AgentRow, ThreadRow } from "../lib/api";

const TYPE_BADGE: Record<string, "default" | "green" | "yellow" | "red" | "blue" | "outline"> = {
  handoff:    "blue",
  finding:    "default",
  decision:   "green",
  question:   "yellow",
  escalation: "red",
  status:     "outline",
  reply:      "outline",
};

function relativeTime(iso: string): string {
  const ageMs = Date.now() - new Date(iso).getTime();
  if (ageMs < 60_000) return "just now";
  if (ageMs < 3_600_000) return `${Math.floor(ageMs / 60_000)}m ago`;
  if (ageMs < 86_400_000) return `${Math.floor(ageMs / 3_600_000)}h ago`;
  return new Date(iso).toLocaleDateString();
}

function InviteAgentsStep({
  plan,
  api,
  onDone,
}: {
  plan: ThreadRow;
  api: WebApiClient;
  onDone: () => void;
}) {
  const agents = useQuery({ queryKey: ["agents"], queryFn: () => api.getAgents() });
  const workers = (agents.data ?? []).filter((a) => a.role === "worker");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const qc = useQueryClient();

  const notify = useMutation({
    mutationFn: () =>
      Promise.all(
        [...selected].map((agentId) =>
          api.createTask({
            title: `Review and contribute to plan: ${plan.title}`,
            description: `A planning discussion has been started. Read the thread and share your perspective.\n\nThread ID: ${plan.id}`,
            assignedTo: agentId,
            metadata: { planThreadId: plan.id },
          })
        )
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["tasks"] });
      onDone();
    },
  });

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }

  return (
    <div className="rounded-lg border border-zinc-700 bg-zinc-900 p-4 space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-zinc-200">Notify agents</h2>
        <span className="text-xs text-zinc-500 font-mono">{plan.id}</span>
      </div>
      <p className="text-xs text-zinc-500">
        Select agents to invite. Each will receive an assigned task pointing to this plan.
      </p>

      {agents.isLoading && <p className="text-xs text-zinc-500">Loading agents…</p>}

      {workers.length === 0 && !agents.isLoading && (
        <p className="text-xs text-zinc-500">No worker agents registered yet.</p>
      )}

      <div className="space-y-1.5">
        {workers.map((a) => (
          <label
            key={a.id}
            className="flex items-center gap-2.5 rounded-md border border-zinc-800 px-3 py-2 cursor-pointer hover:border-zinc-700 transition-colors"
          >
            <input
              type="checkbox"
              checked={selected.has(a.id)}
              onChange={() => toggle(a.id)}
              className="accent-violet-500"
            />
            <span className="text-sm text-zinc-200">{a.name}</span>
            {a.workerType && <Badge variant="outline">{a.workerType}</Badge>}
            {a.specialization && <Badge variant="blue">{a.specialization}</Badge>}
          </label>
        ))}
      </div>

      {notify.isError && (
        <p className="text-xs text-red-400">{(notify.error as Error).message}</p>
      )}

      <div className="flex gap-2 justify-end">
        <Button size="sm" variant="ghost" onClick={onDone}>Skip</Button>
        <Button
          size="sm"
          onClick={() => notify.mutate()}
          disabled={selected.size === 0 || notify.isPending}
        >
          {notify.isPending ? "Notifying…" : `Notify ${selected.size || ""} agent${selected.size === 1 ? "" : "s"}`}
        </Button>
      </div>
    </div>
  );
}

function NewPlanForm({ api, onClose }: { api: WebApiClient; onClose: () => void }) {
  const qc = useQueryClient();
  const [title, setTitle] = useState("");
  const [created, setCreated] = useState<ThreadRow | null>(null);

  const create = useMutation({
    mutationFn: () => api.createPlan(title.trim()),
    onSuccess: (plan) => {
      qc.invalidateQueries({ queryKey: ["plans"] });
      setCreated(plan);
    },
  });

  if (created) {
    return <InviteAgentsStep plan={created} api={api} onDone={onClose} />;
  }

  return (
    <form
      className="rounded-lg border border-zinc-700 bg-zinc-900 p-4 space-y-3"
      onSubmit={(e) => { e.preventDefault(); create.mutate(); }}
    >
      <h2 className="text-sm font-semibold text-zinc-200">New plan</h2>
      <Input
        placeholder="What are we figuring out? (e.g. 'How should we handle auth?')"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        autoFocus
        required
      />
      {create.isError && (
        <p className="text-xs text-red-400">{(create.error as Error).message}</p>
      )}
      <div className="flex gap-2 justify-end">
        <Button type="button" size="sm" variant="ghost" onClick={onClose}>Cancel</Button>
        <Button type="submit" size="sm" disabled={!title.trim() || create.isPending}>
          {create.isPending ? "Creating…" : "Start plan"}
        </Button>
      </div>
    </form>
  );
}

function ConcludeForm({ planId, api, onClose }: { planId: string; api: WebApiClient; onClose: () => void }) {
  const qc = useQueryClient();
  const [summary, setSummary] = useState("");

  const conclude = useMutation({
    mutationFn: () => api.concludePlan(planId, summary.trim() || undefined),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["plans"] });
      onClose();
    },
  });

  return (
    <div className="border-t border-zinc-800 pt-4 space-y-3">
      <p className="text-xs text-zinc-500 uppercase tracking-wider">Conclude plan</p>
      <Textarea
        placeholder="Summarize the decision or outcome (optional)…"
        value={summary}
        onChange={(e) => setSummary(e.target.value)}
        rows={3}
        className="resize-none"
        autoFocus
      />
      <div className="flex gap-2 justify-end">
        <Button size="sm" variant="ghost" onClick={onClose}>Cancel</Button>
        <Button size="sm" onClick={() => conclude.mutate()} disabled={conclude.isPending}>
          {conclude.isPending ? "Concluding…" : "Mark concluded"}
        </Button>
      </div>
    </div>
  );
}

export function Plans({ api }: { api: WebApiClient }) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [showForm, setShowForm] = useState(false);
  const [showConclude, setShowConclude] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const qc = useQueryClient();

  const plans = useQuery({
    queryKey: ["plans"],
    queryFn: () => api.getThreads("plan"),
    refetchInterval: 5_000,
  });

  const agentsQuery = useQuery({
    queryKey: ["agents"],
    queryFn: () => api.getAgents(),
    refetchInterval: 60_000,
  });
  const agentMap = new Map<string, AgentRow>((agentsQuery.data ?? []).map((a) => [a.id, a]));

  const messages = useQuery({
    queryKey: ["messages", selectedId],
    queryFn: () => api.getMessages(selectedId!),
    enabled: selectedId != null,
    refetchInterval: 3_000,
  });

  const send = useMutation({
    mutationFn: () => api.sendMessage(selectedId!, draft.trim()),
    onSuccess: () => {
      setDraft("");
      qc.invalidateQueries({ queryKey: ["messages", selectedId] });
      qc.invalidateQueries({ queryKey: ["plans"] });
    },
  });

  const deletePlan = useMutation({
    mutationFn: (id: string) => api.deleteThread(id),
    onSuccess: () => {
      setSelectedId(null);
      qc.invalidateQueries({ queryKey: ["plans"] });
    },
  });

  useEffect(() => {
    if (!selectedId && plans.data && plans.data.length > 0) {
      setSelectedId(plans.data[0].id);
    }
  }, [plans.data, selectedId]);

  useEffect(() => {
    setDraft("");
    setShowConclude(false);
  }, [selectedId]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages.data]);

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && draft.trim() && !send.isPending) {
      send.mutate();
    }
  }

  const selected = plans.data?.find((p) => p.id === selectedId);
  const isConcluded = selected?.status === "concluded";
  const openPlans = (plans.data ?? []).filter((p) => p.status === "open");
  const concludedPlans = (plans.data ?? []).filter((p) => p.status === "concluded");

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold font-mono">Plans</h1>
        <Button size="sm" onClick={() => setShowForm((v) => !v)}>
          {showForm ? "Cancel" : "+ New plan"}
        </Button>
      </div>

      {showForm && <NewPlanForm api={api} onClose={() => setShowForm(false)} />}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        {/* Plan list */}
        <div className="space-y-3">
          {plans.isLoading && <p className="text-sm text-zinc-500">Loading…</p>}

          {openPlans.length > 0 && (
            <div className="space-y-1">
              <p className="text-xs text-zinc-600 uppercase tracking-wider px-1">Open</p>
              {openPlans.map((p) => (
                <PlanListItem key={p.id} plan={p} selected={selectedId === p.id} onSelect={() => setSelectedId(p.id)} />
              ))}
            </div>
          )}

          {concludedPlans.length > 0 && (
            <div className="space-y-1">
              <p className="text-xs text-zinc-600 uppercase tracking-wider px-1">Concluded</p>
              {concludedPlans.map((p) => (
                <PlanListItem key={p.id} plan={p} selected={selectedId === p.id} onSelect={() => setSelectedId(p.id)} />
              ))}
            </div>
          )}

          {!plans.isLoading && plans.data?.length === 0 && (
            <p className="text-sm text-zinc-500">No plans yet. Start one to think through a problem together.</p>
          )}
        </div>

        {/* Discussion pane */}
        <div className="lg:col-span-2">
          {!selectedId && (
            <div className="rounded-lg border border-dashed border-zinc-800 px-4 py-8 text-center">
              <p className="text-sm text-zinc-500">Select a plan to view the discussion</p>
            </div>
          )}

          {selectedId && selected && (
            <div className="rounded-lg border border-zinc-800 bg-zinc-900">
              {/* Header */}
              <div className="flex items-start justify-between gap-3 px-4 py-3 border-b border-zinc-800">
                <div className="min-w-0">
                  <p className="text-sm font-medium text-zinc-100">{selected.title}</p>
                  <p className="text-xs text-zinc-600 mt-0.5">{relativeTime(selected.createdAt)}</p>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <Badge variant={isConcluded ? "green" : "outline"}>
                    {isConcluded ? "concluded" : "open"}
                  </Badge>
                  {!isConcluded && !showConclude && (
                    <Button size="sm" variant="outline" onClick={() => setShowConclude(true)}>
                      <CheckCheck className="h-3.5 w-3.5 mr-1" />
                      Conclude
                    </Button>
                  )}
                  <Button
                    size="sm"
                    variant="ghost"
                    className="text-zinc-600 hover:text-red-400"
                    onClick={() => deletePlan.mutate(selectedId!)}
                    disabled={deletePlan.isPending}
                    title="Delete plan"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </div>

              {/* Summary banner for concluded plans */}
              {isConcluded && selected.summary && (
                <div className="px-4 py-3 bg-zinc-800/50 border-b border-zinc-800">
                  <p className="text-xs text-zinc-400 uppercase tracking-wider mb-1">Outcome</p>
                  <p className="text-sm text-zinc-200 whitespace-pre-wrap">{selected.summary}</p>
                </div>
              )}

              {/* Messages */}
              <div className="p-4 space-y-4 max-h-[500px] overflow-y-auto">
                {messages.isLoading && <p className="text-xs text-zinc-500">Loading…</p>}
                {(messages.data ?? []).map((m) => {
                  const fromAgent = agentMap.get(m.fromAgent);
                  const toAgent = m.toAgent ? agentMap.get(m.toAgent) : null;
                  const fromLabel = fromAgent?.name ?? m.fromAgent;
                  const toLabel = toAgent?.name ?? m.toAgent;
                  return (
                    <div key={m.id} className="space-y-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        <Badge variant={TYPE_BADGE[m.type] ?? "default"}>{m.type}</Badge>
                        <span className="text-xs font-medium text-zinc-300">{fromLabel}</span>
                        {fromAgent && (
                          <span className="text-xs text-zinc-600 font-mono">{m.fromAgent}</span>
                        )}
                        {toLabel && (
                          <>
                            <span className="text-xs text-zinc-600">→</span>
                            <span className="text-xs text-zinc-400">{toLabel}</span>
                          </>
                        )}
                        <span className="text-xs text-zinc-600">{relativeTime(m.createdAt)}</span>
                      </div>
                      <p className="text-sm text-zinc-200 whitespace-pre-wrap pl-1">{m.body}</p>
                    </div>
                  );
                })}
                {!messages.isLoading && messages.data?.length === 0 && (
                  <p className="text-xs text-zinc-500">No messages yet. Add a thought to get the discussion going.</p>
                )}
                <div ref={messagesEndRef} />
              </div>

              {/* Conclude form or reply box */}
              <div className="px-4 pb-4">
                {showConclude ? (
                  <ConcludeForm planId={selectedId} api={api} onClose={() => setShowConclude(false)} />
                ) : !isConcluded ? (
                  <div className="flex gap-2 items-end border-t border-zinc-800 pt-4">
                    <Textarea
                      placeholder="Share a thought… (⌘↵ to send)"
                      value={draft}
                      onChange={(e) => setDraft(e.target.value)}
                      onKeyDown={handleKeyDown}
                      rows={2}
                      className="flex-1 resize-none"
                    />
                    <Button
                      size="sm"
                      onClick={() => send.mutate()}
                      disabled={!draft.trim() || send.isPending}
                    >
                      <Send className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                ) : null}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function PlanListItem({
  plan,
  selected,
  onSelect,
}: {
  plan: { id: string; title: string; status: string; messageCount: number; createdAt: string };
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      onClick={onSelect}
      className={`w-full text-left rounded-lg border px-3 py-2.5 text-sm transition-colors ${
        selected
          ? "border-zinc-500 bg-zinc-800 text-zinc-100"
          : "border-zinc-800 bg-zinc-900 text-zinc-400 hover:border-zinc-700 hover:text-zinc-200"
      }`}
    >
      <div className="flex items-center justify-between gap-2">
        <p className="font-medium truncate">{plan.title}</p>
        {plan.messageCount > 0 && (
          <span className="shrink-0 text-xs text-zinc-500 tabular-nums">{plan.messageCount}</span>
        )}
      </div>
      <p className="text-xs text-zinc-600 mt-0.5">{relativeTime(plan.createdAt)}</p>
    </button>
  );
}
