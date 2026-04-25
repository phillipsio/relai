import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { AlertTriangle, Circle, CheckCircle2 } from "lucide-react";
import { Card, CardHeader, CardTitle, CardContent } from "../components/ui/card";
import { Badge } from "../components/ui/badge";
import type { WebApiClient } from "../lib/api";

const STATUS_ORDER = ["pending", "assigned", "in_progress", "blocked", "completed", "cancelled"];

export function Dashboard({ api }: { api: WebApiClient }) {
  const agents = useQuery({ queryKey: ["agents"], queryFn: () => api.getAgents(), refetchInterval: 10_000 });
  const tasks  = useQuery({ queryKey: ["tasks", "all"], queryFn: () => api.getTasks(), refetchInterval: 5_000 });

  const tasksByStatus = (tasks.data ?? []).reduce<Record<string, number>>((acc, t) => {
    acc[t.status] = (acc[t.status] ?? 0) + 1;
    return acc;
  }, {});

  const now = Date.now();
  const onlineAgents = (agents.data ?? []).filter(
    (a) => now - new Date(a.lastSeenAt).getTime() < 10 * 60 * 1000
  );
  const escalations = (tasks.data ?? []).filter((t) => t.status === "blocked");

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-semibold font-mono">Dashboard</h1>

      {escalations.length > 0 && (
        <div className="rounded-lg border border-red-800 bg-red-950/50 p-4 flex items-start gap-3">
          <AlertTriangle className="h-5 w-5 text-red-400 mt-0.5 shrink-0" />
          <div>
            <p className="text-sm font-medium text-red-300">{escalations.length} blocked task{escalations.length > 1 ? "s" : ""}</p>
            <div className="mt-1 space-y-1">
              {escalations.map((t) => (
                <p key={t.id} className="text-xs text-red-400">{t.title}</p>
              ))}
            </div>
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        {/* Agents */}
        <Card>
          <CardHeader><CardTitle className="text-sm text-zinc-400">Agents</CardTitle></CardHeader>
          <CardContent className="space-y-2">
            {agents.isLoading && <p className="text-xs text-zinc-500">Loading…</p>}
            {(agents.data ?? []).filter((a) => a.role === "worker").map((a) => {
              const online = now - new Date(a.lastSeenAt).getTime() < 10 * 60 * 1000;
              return (
                <div key={a.id} className="flex items-center gap-2 text-sm">
                  {online
                    ? <CheckCircle2 className="h-3.5 w-3.5 text-green-400 shrink-0" />
                    : <Circle className="h-3.5 w-3.5 text-zinc-600 shrink-0" />}
                  <span className={online ? "text-zinc-200" : "text-zinc-500"}>{a.name}</span>
                  <div className="ml-auto flex items-center gap-1">
                    {a.specialization && <Badge variant="blue">{a.specialization}</Badge>}
                    {a.tier != null && (
                      <Badge variant={a.tier === 2 ? "green" : "outline"}>tier {a.tier}</Badge>
                    )}
                  </div>
                </div>
              );
            })}
            {agents.data?.filter((a) => a.role === "worker").length === 0 && (
              <p className="text-xs text-zinc-500">No agents registered.</p>
            )}
          </CardContent>
        </Card>

        {/* Task summary */}
        <Card>
          <CardHeader><CardTitle className="text-sm text-zinc-400">Tasks</CardTitle></CardHeader>
          <CardContent className="space-y-1.5">
            {tasks.isLoading && <p className="text-xs text-zinc-500">Loading…</p>}
            {STATUS_ORDER.filter((s) => tasksByStatus[s] > 0).map((status) => (
              <Link
                key={status}
                to={`/tasks?status=${status}`}
                className="flex items-center justify-between text-sm rounded px-1 -mx-1 hover:bg-zinc-800 transition-colors"
              >
                <span className="text-zinc-400">{status.replace("_", " ")}</span>
                <span className="font-mono text-zinc-200">{tasksByStatus[status]}</span>
              </Link>
            ))}
            {!tasks.isLoading && tasks.data?.length === 0 && (
              <p className="text-xs text-zinc-500">No tasks yet.</p>
            )}
          </CardContent>
        </Card>
      </div>

      {onlineAgents.length > 0 && (
        <Card>
          <CardHeader><CardTitle className="text-sm text-zinc-400">Online now ({onlineAgents.length})</CardTitle></CardHeader>
          <CardContent>
            <div className="flex flex-wrap gap-2">
              {onlineAgents.map((a) => (
                <div key={a.id} className="flex items-center gap-1.5 rounded border border-zinc-700 px-2.5 py-1 text-xs">
                  <CheckCircle2 className="h-3 w-3 text-green-400" />
                  <span className="text-zinc-200">{a.name}</span>
                  {a.specialization && <span className="text-blue-400">({a.specialization})</span>}
                  {a.tier != null && <span className="text-zinc-500">T{a.tier}</span>}
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
