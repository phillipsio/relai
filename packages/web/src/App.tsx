import { useState } from "react";
import { BrowserRouter, Routes, Route, NavLink } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { LayoutDashboard, ListTodo, MessageSquare, Bot, FolderOpen, LogOut, Workflow, Lightbulb } from "lucide-react";
import { getConfig, saveConfig, clearConfig } from "./lib/config";
import { WebApiClient } from "./lib/api";
import { Setup } from "./pages/Setup";
import { Dashboard } from "./pages/Dashboard";
import { Tasks } from "./pages/Tasks";
import { Threads } from "./pages/Threads";
import { Plans } from "./pages/Plans";
import { Agents } from "./pages/Agents";
import { Projects } from "./pages/Projects";

const qc = new QueryClient({ defaultOptions: { queries: { retry: 1 } } });

function Shell({ api, onProjectSwitch, onLogout }: {
  api: WebApiClient;
  onProjectSwitch: (projectId: string) => void;
  onLogout: () => void;
}) {
  const navCls = ({ isActive }: { isActive: boolean }) =>
    `flex items-center gap-2 rounded-md px-3 py-2 text-sm transition-colors ${
      isActive ? "bg-zinc-800 text-zinc-100" : "text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/50"
    }`;

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-50 flex">
      <nav className="w-52 shrink-0 border-r border-zinc-800 p-3 flex flex-col gap-1">
        <div className="px-3 py-2 mb-2 flex items-center gap-2">
          <Workflow className="h-5 w-5 shrink-0" style={{ color: "#a78bfa" }} />
          <span className="font-mono text-xl font-semibold tracking-tight">
            <span className="text-zinc-100">Rel</span><span style={{ color: "#a78bfa" }}>ai</span>
          </span>
        </div>
        <NavLink to="/" end className={navCls}>
          <LayoutDashboard className="h-4 w-4" /> Dashboard
        </NavLink>
        <NavLink to="/tasks" className={navCls}>
          <ListTodo className="h-4 w-4" /> Tasks
        </NavLink>
        <NavLink to="/agents" className={navCls}>
          <Bot className="h-4 w-4" /> Agents
        </NavLink>
        <NavLink to="/plans" className={navCls}>
          <Lightbulb className="h-4 w-4" /> Plans
        </NavLink>
        <NavLink to="/threads" className={navCls}>
          <MessageSquare className="h-4 w-4" /> Threads
        </NavLink>
        <NavLink to="/projects" className={navCls}>
          <FolderOpen className="h-4 w-4" /> Projects
        </NavLink>
        <div className="flex-1" />
        <div className="border-t border-zinc-800 pt-2">
          <p className="px-3 py-1.5 text-xs text-zinc-600 font-mono truncate">{api.projectId}</p>
          <button
            onClick={onLogout}
            className="flex items-center gap-2 w-full rounded-md px-3 py-2 text-sm text-zinc-500 hover:text-zinc-200 hover:bg-zinc-800/50 transition-colors"
          >
            <LogOut className="h-4 w-4" /> Disconnect
          </button>
        </div>
      </nav>

      <main className="flex-1 overflow-auto p-6">
        <Routes>
          <Route path="/"         element={<Dashboard api={api} />} />
          <Route path="/tasks"    element={<Tasks api={api} />} />
          <Route path="/agents"   element={<Agents api={api} />} />
          <Route path="/plans"    element={<Plans api={api} />} />
          <Route path="/threads"  element={<Threads api={api} />} />
          <Route path="/projects" element={<Projects api={api} onSwitch={onProjectSwitch} />} />
        </Routes>
      </main>
    </div>
  );
}

export default function App() {
  const [api, setApi] = useState<WebApiClient | null>(() => {
    const cfg = getConfig();
    return cfg ? new WebApiClient(cfg) : null;
  });

  function handleDone() {
    const cfg = getConfig();
    if (cfg) setApi(new WebApiClient(cfg));
  }

  function handleProjectSwitch(projectId: string) {
    if (!projectId) { clearConfig(); setApi(null); return; }
    const cfg = getConfig();
    if (cfg) {
      saveConfig({ ...cfg, projectId });
      setApi(new WebApiClient({ ...cfg, projectId }));
    }
  }

  function handleLogout() {
    clearConfig();
    setApi(null);
  }

  if (!api) return <Setup onDone={handleDone} />;

  return (
    <QueryClientProvider client={qc}>
      <BrowserRouter>
        <Shell api={api} onProjectSwitch={handleProjectSwitch} onLogout={handleLogout} />
      </BrowserRouter>
    </QueryClientProvider>
  );
}
