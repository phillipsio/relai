# Two-person test runbook

Goal: validate the redesigned auth + invite + per-agent-token flow with a real coworker on a different machine. You run the API/DB; they only need a CLI and an MCP-capable agent (Claude Code, Cursor, etc.).

If anything in this runbook is annoying, that friction *is* the test signal — note it.

## Prerequisites

**On your (host) machine:**
- Docker (for Postgres) and Node.js 20+ / pnpm 9+ (already required by the project)
- A way for your coworker's machine to reach the API:
  - **Quickest:** `ngrok http 3010` (no install, public HTTPS URL, 2-minute setup)
  - **Tailscale / WireGuard:** if you both have it, the API host is just reachable on the tailnet
  - **Cloud VM:** if you want this to outlive the test session

**On your coworker's machine:**
- Node.js 20+ and pnpm 9+
- An MCP-capable client (Claude Code, Cursor, Windsurf, etc.)
- The relai repo cloned (until we publish to npm — see `project_cli_design.md` for the deferred work)

## 1. Host side — bring the API up

```bash
# In the relai repo
docker compose up -d
DATABASE_URL=postgresql://relai:relai@localhost:5433/relai pnpm --filter @relai/db db:push
cp .env.example .env   # only if you don't have one yet
# Edit .env: set API_SECRET to something strong (you only need it for `orch init`)

pnpm --filter @relai/api dev
```

Confirm with `curl -H "Authorization: Bearer $API_SECRET" http://localhost:3010/health` → `{"ok":true}`.

## 2. Host side — expose the API to the internet

Pick one:

```bash
# Option A: ngrok (fastest)
ngrok http 3010
# Copy the https://<random>.ngrok.app URL — that's your <PUBLIC_API_URL>.

# Option B: tailscale — get the host's tailnet IP, e.g. 100.x.y.z
# <PUBLIC_API_URL> = http://100.x.y.z:3010

# Option C: cloud VM — point a DNS name at it
```

## 3. Host side — register yourself as the first agent

```bash
pnpm --filter @relai/cli build
node packages/cli/dist/index.js init
# OR if you have a global symlink: orch init
```

Walk through the prompts:
- **API URL:** the public one from step 2 (or `http://localhost:3010` if you're on the host)
- **API admin secret:** the `API_SECRET` from `.env`
- **Create new project:** yes
- **Project name:** something memorable
- **Agent name:** e.g. `jim-host`
- **Specialization:** `architect` or whatever fits

After this, `~/.config/orch/config.json` holds your per-agent token. The admin secret is no longer needed for day-to-day calls.

If you also want to drive relai from this machine via Claude Code (recommended), copy the printed MCP snippet into your project's `.mcp.json`.

## 4. Host side — invite your coworker

```bash
node packages/cli/dist/index.js project invite \
  --name <coworker-suggested-name> \
  --specialization writer \
  --ttl 86400
```

It prints a single line:

```
orch login --invite inv_<base64url>
```

Send that whole line to your coworker — plus the **public API URL** from step 2. They need both. The invite is single-use and expires when `--ttl` says (default 7 days).

## 5. Coworker side — install + log in

```bash
git clone <repo-url> relai
cd relai
pnpm install
pnpm --filter @relai/cli build

# Run the line you sent them
node packages/cli/dist/index.js login \
  --invite inv_<...> \
  --api <PUBLIC_API_URL>
```

Prompts:
- **Agent name:** their choice (the suggestion you set is the default)
- **Specialization:** their choice

This creates an agent record in your project, mints a per-agent token for them, and writes `~/.config/orch/config.json` on their machine. They never see your admin secret.

## 6. Coworker side — wire up MCP

`orch login` prints a ready-to-paste `mcpServers` block at the end of step 5. Drop it into their project's `.mcp.json` (or `~/.claude.json`).

Until `@relai/mcp-server` is published to npm, replace `npx @relai/mcp-server` with `node /path/to/relai/packages/mcp-server/dist/index.js` after running `pnpm --filter @relai/mcp-server build`.

Restart their MCP client. Confirm via `/mcp` (or equivalent) that `orch` shows as connected with 9 tools.

## 7. Try the actual coordination

In your Claude Code session (host):

```
You: Use the orch tools to create a task in this project titled "Audit the
auth flow" with description "Walk the new per-agent token path end-to-end
and flag anything weird." Assign it to <coworker's agent id>.
```

In their session (coworker):

```
Coworker: Use the orch tools to check my unread messages and pending tasks.
```

Things to verify in this round-trip:
- The task shows up for them.
- A reply via `send_message` shows up for you.
- The web dashboard at `http://localhost:5173` (host only) shows both agents and the task.
- If you have time: `curl -N -H "Authorization: Bearer <your-token>" <PUBLIC_API_URL>/events` — you should see a stream of `event:` lines as activity happens.

## 8. Tear-down

```bash
# Host
node packages/cli/dist/index.js token revoke <coworker's token id>   # optional
docker compose down                                                  # stops Postgres

# Coworker
rm ~/.config/orch/config.json
# Remove the orch entry from their .mcp.json
```

## Solo test (fake the second person)

If you don't have a real coworker on hand, you can play both sides from the same machine. The CLI honors `ORCH_CONFIG_DIR` so two terminals can hold different agent identities side by side.

```bash
# Terminal A — "host" identity, default config dir
node packages/cli/dist/index.js init
# … walk through prompts, create project, register as e.g. "jim-host"
node packages/cli/dist/index.js project invite --name fake-coworker --ttl 3600
# Copy the printed `orch login --invite ...` line.

# Terminal B — "coworker" identity, separate config dir
export ORCH_CONFIG_DIR=/tmp/orch-coworker
node packages/cli/dist/index.js login --invite inv_<...> --api http://localhost:3010
# Walk through the prompts as the imaginary coworker.
```

You skip the public-URL step entirely; both sides talk to `http://localhost:3010`.

From here:
- Use `orch tasks`, `orch send`, `orch inbox` from either terminal — each sees the world from its own agent's perspective.
- For MCP-from-Claude-Code-as-the-coworker, point your MCP `.mcp.json` env at the coworker's `apiToken` / `agentId` from `/tmp/orch-coworker/config.json`. Restart Claude Code; you're now driving relai as the coworker agent.
- Watch events from one identity while acting from the other: `curl -N -H "Authorization: Bearer <coworker-token>" http://localhost:3010/events` in a third terminal — you should see SSE lines as terminal A sends messages.

This validates the full auth + invite + per-agent-token + event-fan-out path; only thing it doesn't validate is the actual cross-machine networking (so don't skip a real two-person test before going further with the design).

## Things to capture during the test

Real friction is the point. Note (somewhere — a thread in relai itself works):
- Any step where the runbook was wrong or unclear.
- Any prompt that asked something the user couldn't answer.
- Whether "humans optional" actually holds — did the coworker want notifications, or was checking via Claude Code fine?
- Did `--to <agentId>` feel usable, or do we need a friendlier handle?
- Anything that felt obviously slow, redundant, or surprising.

Feed the findings back into the design doc at
`~/.claude/projects/-Users-jim-PhpstormProjects-relai/memory/project_cli_design.md`.
