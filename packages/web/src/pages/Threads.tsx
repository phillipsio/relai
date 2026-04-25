import { useState, useEffect, useRef } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Send } from "lucide-react";
import { Card, CardHeader, CardTitle, CardContent } from "../components/ui/card";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Textarea } from "../components/ui/textarea";
import type { WebApiClient, AgentRow } from "../lib/api";

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

export function Threads({ api }: { api: WebApiClient }) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const qc = useQueryClient();

  const threads = useQuery({ queryKey: ["threads", "operational"], queryFn: () => api.getThreads(), refetchInterval: 3_000 });
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
      qc.invalidateQueries({ queryKey: ["threads"] });
    },
  });

  useEffect(() => {
    if (!selectedId && threads.data) {
      const first = threads.data.find((t) => t.type !== "plan");
      if (first) setSelectedId(first.id);
    }
  }, [threads.data, selectedId]);

  useEffect(() => {
    setDraft("");
  }, [selectedId]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages.data]);

  const operationalThreads = (threads.data ?? []).filter((t) => t.type !== "plan");
  const selected = operationalThreads.find((t) => t.id === selectedId);

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && draft.trim() && !send.isPending) {
      send.mutate();
    }
  }

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold font-mono">Threads</h1>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        {/* Thread list */}
        <div className="space-y-1">
          {threads.isLoading && <p className="text-sm text-zinc-500">Loading…</p>}
          {operationalThreads.map((t) => (
            <button
              key={t.id}
              onClick={() => setSelectedId(t.id)}
              className={`w-full text-left rounded-lg border px-3 py-2.5 text-sm transition-colors ${
                selectedId === t.id
                  ? "border-zinc-500 bg-zinc-800 text-zinc-100"
                  : "border-zinc-800 bg-zinc-900 text-zinc-400 hover:border-zinc-700 hover:text-zinc-200"
              }`}
            >
              <div className="flex items-center justify-between gap-2">
                <p className="font-medium truncate">{t.title}</p>
                {t.messageCount > 0 && (
                  <span className="shrink-0 text-xs text-zinc-500 tabular-nums">{t.messageCount}</span>
                )}
              </div>
              <p className="text-xs text-zinc-600 mt-0.5">{relativeTime(t.createdAt)}</p>
            </button>
          ))}
          {!threads.isLoading && threads.data?.length === 0 && (
            <p className="text-sm text-zinc-500">No threads yet.</p>
          )}
        </div>

        {/* Message pane */}
        <div className="lg:col-span-2">
          {!selectedId && (
            <Card>
              <CardContent className="py-8 text-center">
                <p className="text-sm text-zinc-500">Select a thread to view messages</p>
              </CardContent>
            </Card>
          )}

          {selectedId && (
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm">{selected?.title ?? selectedId}</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="space-y-4 max-h-[600px] overflow-y-auto pr-1">
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
                    <p className="text-xs text-zinc-500">No messages yet.</p>
                  )}
                  <div ref={messagesEndRef} />
                </div>

                <div className="mt-4 flex gap-2 items-end border-t border-zinc-800 pt-4">
                  <Textarea
                    placeholder="Reply as human… (⌘↵ to send)"
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
              </CardContent>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}
