import { useState } from "react";
import { Card, CardHeader, CardTitle, CardContent } from "../components/ui/card";
import { Input } from "../components/ui/input";
import { Button } from "../components/ui/button";
import { ChevronRight } from "lucide-react";
import { saveConfig } from "../lib/config";
import type { ProjectRow } from "../lib/api";

async function apiFetch<T>(url: string, secret: string, opts?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...opts,
    headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/json", ...opts?.headers },
  });
  const json = await res.json() as { data?: T; error?: { message: string } };
  if (!res.ok) throw new Error(json.error?.message ?? `Error ${res.status}`);
  return json.data as T;
}

// ── Step 1: Connect ───────────────────────────────────────────────────────────

function StepConnect({ onDone }: { onDone: (base: string, secret: string) => void }) {
  const [apiUrl, setApiUrl]       = useState("http://localhost:3010");
  const [apiSecret, setApiSecret] = useState("");
  const [error, setError]         = useState("");
  const [loading, setLoading]     = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      const base = apiUrl.replace(/\/$/, "");
      await apiFetch(`${base}/health`, apiSecret);
      onDone(base, apiSecret);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not reach the API.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-3">
      <div className="space-y-1">
        <label className="text-xs text-zinc-400">API URL</label>
        <Input value={apiUrl} onChange={(e) => setApiUrl(e.target.value)} placeholder="http://localhost:3010" required />
      </div>
      <div className="space-y-1">
        <label className="text-xs text-zinc-400">API Secret</label>
        <Input type="password" value={apiSecret} onChange={(e) => setApiSecret(e.target.value)} placeholder="API_SECRET from .env" required />
      </div>
      {error && <p className="text-xs text-red-400">{error}</p>}
      <Button type="submit" className="w-full" disabled={loading}>
        {loading ? "Connecting…" : "Connect"}
      </Button>
    </form>
  );
}

// ── Step 2: Pick project ──────────────────────────────────────────────────────

function StepProject({ base, secret, onDone }: { base: string; secret: string; onDone: (p: ProjectRow) => void }) {
  const [projects, setProjects] = useState<ProjectRow[] | null>(null);
  const [error, setError]       = useState("");

  useState(() => {
    apiFetch<ProjectRow[]>(`${base}/projects`, secret)
      .then(setProjects)
      .catch((err) => setError(err.message));
  });

  if (projects === null && !error) {
    return <p className="text-sm text-zinc-500 py-4 text-center">Loading projects…</p>;
  }

  return (
    <div className="space-y-2">
      {error && <p className="text-xs text-red-400">{error}</p>}
      {(projects ?? []).length === 0 && (
        <p className="text-sm text-zinc-500 py-4 text-center">No projects found. Create one via the CLI first.</p>
      )}
      {(projects ?? []).map((p) => (
        <button
          key={p.id}
          onClick={() => onDone(p)}
          className="w-full flex items-center justify-between rounded-lg border border-zinc-700 bg-zinc-800/50 px-4 py-3 text-left hover:border-zinc-500 hover:bg-zinc-800 transition-colors group"
        >
          <div>
            <p className="text-sm font-medium text-zinc-100">{p.name}</p>
            {p.description && <p className="text-xs text-zinc-500 mt-0.5">{p.description}</p>}
            <p className="text-xs text-zinc-700 mt-0.5 font-mono">{p.id}</p>
          </div>
          <ChevronRight className="h-4 w-4 text-zinc-600 group-hover:text-zinc-300 shrink-0" />
        </button>
      ))}
    </div>
  );
}

// ── Root wizard ───────────────────────────────────────────────────────────────

const STEPS = ["Connect", "Project"] as const;
type Step = typeof STEPS[number];

export function Setup({ onDone }: { onDone: () => void }) {
  const [step, setStep]     = useState<Step>("Connect");
  const [base, setBase]     = useState("");
  const [secret, setSecret] = useState("");

  const stepIndex = STEPS.indexOf(step);

  function handleConnect(b: string, s: string) {
    setBase(b); setSecret(s); setStep("Project");
  }

  function handleProject(p: ProjectRow) {
    saveConfig({ apiUrl: base, apiSecret: secret, projectId: p.id });
    onDone();
  }

  return (
    <div className="min-h-screen bg-zinc-950 flex items-center justify-center p-4">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle className="text-lg font-mono">relai</CardTitle>
          <div className="flex items-center gap-2 mt-1">
            {STEPS.map((s, i) => (
              <div key={s} className="flex items-center gap-2">
                <span className={`text-xs ${i <= stepIndex ? "text-zinc-200" : "text-zinc-600"}`}>{s}</span>
                {i < STEPS.length - 1 && <ChevronRight className="h-3 w-3 text-zinc-700" />}
              </div>
            ))}
          </div>
        </CardHeader>
        <CardContent>
          {step === "Connect" && <StepConnect onDone={handleConnect} />}
          {step === "Project" && <StepProject base={base} secret={secret} onDone={handleProject} />}
        </CardContent>
      </Card>
    </div>
  );
}
