import { useState, useEffect, useRef } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Send, CheckCheck, Trash2, Plus } from "lucide-react";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Textarea } from "../components/ui/textarea";
import type { WebApiClient, AgentRow, ThreadRow } from "../lib/api";

const TYPE_BADGE: Record<string, "default" | "green" | "yellow" | "red" | "blue" | "outline"> = {
  handoff: "blue", finding: "default", decision: "green", question: "yellow", escalation: "red", status: "outline", reply: "outline",
};
const STATUS_BADGE: Record<string, "default" | "blue" | "yellow" | "green" | "red" | "purple" | "outline"> = {
  proposed: "purple", pending: "outline", assigned: "blue", in_progress: "yellow",
  pending_verification: "purple", completed: "green", blocked: "red", cancelled: "outline",
};

function relativeTime(iso: string): string {
  const ageMs = Date.now() - new Date(iso).getTime();
  if (ageMs < 60_000) return "just now";
  if (ageMs < 3_600_000) return `${Math.floor(ageMs / 60_000)}m ago`;
  if (ageMs < 86_400_000) return `${Math.floor(ageMs / 3_600_000)}h ago`;
  return new Date(iso).toLocaleDateString();
}

// ── Child issues of an Epic (tasks with epicId === epic.id) ───────────────────
function ChildIssues({ epicId, api }: { epicId: string; api: WebApiClient }) {
  const qc = useQueryClient();
  const [show, setShow] = useState(false);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");

  const issues = useQuery({
    queryKey: ["epic-issues", epicId],
    queryFn: () => api.getTasks(undefined, epicId),
    refetchInterval: 5_000,
  });
  const spawn = useMutation({
    mutationFn: () => api.createTask({ title: title.trim(), description: description.trim() || title.trim(), epicId }),
    onSuccess: () => {
      setTitle(""); setDescription(""); setShow(false);
      qc.invalidateQueries({ queryKey: ["epic-issues", epicId] });
      qc.invalidateQueries({ queryKey: ["issues"] });
    },
  });

  const rows = issues.data ?? [];
  return (
    <div className="px-4 py-3 border-b border-zinc-800">
      <div className="flex items-center justify-between mb-2">
        <p className="text-xs text-zinc-600 uppercase tracking-wider">Child issues ({rows.length})</p>
        <Button size="sm" variant="ghost" onClick={() => setShow((v) => !v)}>
          <Plus className="h-3.5 w-3.5 mr-1" /> Spawn issue
        </Button>
      </div>

      {show && (
        <div className="mb-3 space-y-2 rounded-md border border-zinc-800 p-3">
          <Input placeholder="Issue title" value={title} onChange={(e) => setTitle(e.target.value)} autoFocus />
          <Textarea placeholder="Description (optional)" value={description} onChange={(e) => setDescription(e.target.value)} rows={2} className="resize-none" />
          <div className="flex gap-2 justify-end">
            <Button size="sm" variant="ghost" onClick={() => setShow(false)}>Cancel</Button>
            <Button size="sm" onClick={() => spawn.mutate()} disabled={!title.trim() || spawn.isPending}>
              {spawn.isPending ? "Spawning…" : "Spawn"}
            </Button>
          </div>
          {spawn.isError && <p className="text-xs text-red-400">{(spawn.error as Error).message}</p>}
        </div>
      )}

      <div className="space-y-1">
        {rows.map((t) => (
          <div key={t.id} className="flex items-center gap-2 rounded-md border border-zinc-800 px-3 py-1.5">
            <span className="text-sm text-zinc-200 truncate flex-1">{t.title}</span>
            <Badge variant={STATUS_BADGE[t.status] ?? "default"}>{t.status.replace(/_/g, " ")}</Badge>
          </div>
        ))}
        {rows.length === 0 && <p className="text-xs text-zinc-500">No issues spawned from this epic yet.</p>}
      </div>
    </div>
  );
}

function NewEpicForm({ api, onClose }: { api: WebApiClient; onClose: () => void }) {
  const qc = useQueryClient();
  const [title, setTitle] = useState("");
  const create = useMutation({
    mutationFn: () => api.createPlan(title.trim()),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["epics"] }); onClose(); },
  });
  return (
    <form className="rounded-lg border border-zinc-700 bg-zinc-900 p-4 space-y-3"
      onSubmit={(e) => { e.preventDefault(); create.mutate(); }}>
      <h2 className="text-sm font-semibold text-zinc-200">New epic</h2>
      <Input placeholder="What are we figuring out? (e.g. 'How should we handle auth?')"
        value={title} onChange={(e) => setTitle(e.target.value)} autoFocus required />
      {create.isError && <p className="text-xs text-red-400">{(create.error as Error).message}</p>}
      <div className="flex gap-2 justify-end">
        <Button type="button" size="sm" variant="ghost" onClick={onClose}>Cancel</Button>
        <Button type="submit" size="sm" disabled={!title.trim() || create.isPending}>
          {create.isPending ? "Creating…" : "Start epic"}
        </Button>
      </div>
    </form>
  );
}

function ConcludeForm({ epicId, api, onClose }: { epicId: string; api: WebApiClient; onClose: () => void }) {
  const qc = useQueryClient();
  const [summary, setSummary] = useState("");
  const conclude = useMutation({
    mutationFn: () => api.concludePlan(epicId, summary.trim() || undefined),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["epics"] }); onClose(); },
  });
  return (
    <div className="border-t border-zinc-800 pt-4 space-y-3">
      <p className="text-xs text-zinc-500 uppercase tracking-wider">Conclude epic</p>
      <Textarea placeholder="Summarize the decision or outcome (optional)…"
        value={summary} onChange={(e) => setSummary(e.target.value)} rows={3} className="resize-none" autoFocus />
      <div className="flex gap-2 justify-end">
        <Button size="sm" variant="ghost" onClick={onClose}>Cancel</Button>
        <Button size="sm" onClick={() => conclude.mutate()} disabled={conclude.isPending}>
          {conclude.isPending ? "Concluding…" : "Mark concluded"}
        </Button>
      </div>
    </div>
  );
}

function EpicListItem({ epic, selected, onSelect }: {
  epic: { id: string; title: string; status: string; messageCount: number; createdAt: string };
  selected: boolean; onSelect: () => void;
}) {
  return (
    <button onClick={onSelect}
      className={`w-full text-left rounded-lg border px-3 py-2.5 text-sm transition-colors ${
        selected ? "border-zinc-500 bg-zinc-800 text-zinc-100" : "border-zinc-800 bg-zinc-900 text-zinc-400 hover:border-zinc-700 hover:text-zinc-200"
      }`}>
      <div className="flex items-center justify-between gap-2">
        <p className="font-medium truncate">{epic.title}</p>
        {epic.messageCount > 0 && <span className="shrink-0 text-xs text-zinc-500 tabular-nums">{epic.messageCount}</span>}
      </div>
      <p className="text-xs text-zinc-600 mt-0.5">{relativeTime(epic.createdAt)}</p>
    </button>
  );
}

export function Epics({ api }: { api: WebApiClient }) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [showForm, setShowForm] = useState(false);
  const [showConclude, setShowConclude] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const qc = useQueryClient();

  const epics = useQuery({ queryKey: ["epics"], queryFn: () => api.getThreads("plan"), refetchInterval: 5_000 });
  const agentsQuery = useQuery({ queryKey: ["agents"], queryFn: () => api.getAgents(), refetchInterval: 60_000 });
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
      qc.invalidateQueries({ queryKey: ["epics"] });
    },
  });
  const deleteEpic = useMutation({
    mutationFn: (id: string) => api.deleteThread(id),
    onSuccess: () => { setSelectedId(null); qc.invalidateQueries({ queryKey: ["epics"] }); },
  });

  useEffect(() => {
    if (!selectedId && epics.data && epics.data.length > 0) setSelectedId(epics.data[0].id);
  }, [epics.data, selectedId]);
  useEffect(() => { setDraft(""); setShowConclude(false); }, [selectedId]);
  useEffect(() => { messagesEndRef.current?.scrollIntoView({ behavior: "smooth" }); }, [messages.data]);

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && draft.trim() && !send.isPending) send.mutate();
  }

  const selected = epics.data?.find((p) => p.id === selectedId);
  const isConcluded = selected?.status === "concluded";
  const openEpics = (epics.data ?? []).filter((p: ThreadRow) => p.status === "open");
  const concludedEpics = (epics.data ?? []).filter((p: ThreadRow) => p.status === "concluded");

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold font-mono">Epics</h1>
        <Button size="sm" onClick={() => setShowForm((v) => !v)}>{showForm ? "Cancel" : "+ New epic"}</Button>
      </div>

      {showForm && <NewEpicForm api={api} onClose={() => setShowForm(false)} />}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        {/* Epic list */}
        <div className="space-y-3">
          {epics.isLoading && <p className="text-sm text-zinc-500">Loading…</p>}
          {openEpics.length > 0 && (
            <div className="space-y-1">
              <p className="text-xs text-zinc-600 uppercase tracking-wider px-1">Open</p>
              {openEpics.map((p) => <EpicListItem key={p.id} epic={p} selected={selectedId === p.id} onSelect={() => setSelectedId(p.id)} />)}
            </div>
          )}
          {concludedEpics.length > 0 && (
            <div className="space-y-1">
              <p className="text-xs text-zinc-600 uppercase tracking-wider px-1">Concluded</p>
              {concludedEpics.map((p) => <EpicListItem key={p.id} epic={p} selected={selectedId === p.id} onSelect={() => setSelectedId(p.id)} />)}
            </div>
          )}
          {!epics.isLoading && epics.data?.length === 0 && (
            <p className="text-sm text-zinc-500">No epics yet. Start one to think through a problem together.</p>
          )}
        </div>

        {/* Epic detail */}
        <div className="lg:col-span-2">
          {!selectedId && (
            <div className="rounded-lg border border-dashed border-zinc-800 px-4 py-8 text-center">
              <p className="text-sm text-zinc-500">Select an epic to view the discussion and its issues</p>
            </div>
          )}

          {selectedId && selected && (
            <div className="rounded-lg border border-zinc-800 bg-zinc-900">
              <div className="flex items-start justify-between gap-3 px-4 py-3 border-b border-zinc-800">
                <div className="min-w-0">
                  <p className="text-sm font-medium text-zinc-100">{selected.title}</p>
                  <p className="text-xs text-zinc-600 mt-0.5">{relativeTime(selected.createdAt)}</p>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <Badge variant={isConcluded ? "green" : "outline"}>{isConcluded ? "concluded" : "open"}</Badge>
                  {!isConcluded && !showConclude && (
                    <Button size="sm" variant="outline" onClick={() => setShowConclude(true)}>
                      <CheckCheck className="h-3.5 w-3.5 mr-1" /> Conclude
                    </Button>
                  )}
                  <Button size="sm" variant="ghost" className="text-zinc-600 hover:text-red-400"
                    onClick={() => deleteEpic.mutate(selectedId!)} disabled={deleteEpic.isPending} title="Delete epic">
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </div>

              {isConcluded && selected.summary && (
                <div className="px-4 py-3 bg-zinc-800/50 border-b border-zinc-800">
                  <p className="text-xs text-zinc-400 uppercase tracking-wider mb-1">Outcome</p>
                  <p className="text-sm text-zinc-200 whitespace-pre-wrap">{selected.summary}</p>
                </div>
              )}

              <ChildIssues epicId={selectedId} api={api} />

              {/* Discussion */}
              <div className="p-4 space-y-4 max-h-[420px] overflow-y-auto">
                {messages.isLoading && <p className="text-xs text-zinc-500">Loading…</p>}
                {(messages.data ?? []).map((m) => {
                  const fromAgent = agentMap.get(m.fromAgent);
                  const toAgent = m.toAgent ? agentMap.get(m.toAgent) : null;
                  return (
                    <div key={m.id} className="space-y-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        <Badge variant={TYPE_BADGE[m.type] ?? "default"}>{m.type}</Badge>
                        <span className="text-xs font-medium text-zinc-300">{fromAgent?.name ?? m.fromAgent}</span>
                        {toAgent && (<><span className="text-xs text-zinc-600">→</span><span className="text-xs text-zinc-400">{toAgent.name}</span></>)}
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

              <div className="px-4 pb-4">
                {showConclude ? (
                  <ConcludeForm epicId={selectedId} api={api} onClose={() => setShowConclude(false)} />
                ) : !isConcluded ? (
                  <div className="flex gap-2 items-end border-t border-zinc-800 pt-4">
                    <Textarea placeholder="Share a thought… (⌘↵ to send)" value={draft}
                      onChange={(e) => setDraft(e.target.value)} onKeyDown={handleKeyDown} rows={2} className="flex-1 resize-none" />
                    <Button size="sm" onClick={() => send.mutate()} disabled={!draft.trim() || send.isPending}>
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
