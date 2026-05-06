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
- Node.js 20+ (npm comes with it)
- An MCP-capable client (Claude Code, Cursor, Windsurf, etc.)
- No clone, no pnpm — `relai` and the MCP server are both on npm

## 1. Host side — bring the API up

```bash
# In the relai repo
docker compose up -d
DATABASE_URL=postgresql://relai:relai@localhost:5433/relai pnpm --filter @getrelai/db db:push
cp .env.example .env   # only if you don't have one yet
# Edit .env: set API_SECRET to something strong (you only need it for `relai init`)

pnpm --filter @getrelai/api dev
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
npm install -g @getrelai/cli   # if you don't have it yet
relai init
```

Walk through the prompts:
- **API URL:** the public one from step 2 (or `http://localhost:3010` if you're on the host)
- **API admin secret:** the `API_SECRET` from `.env`
- **Create new project:** yes
- **Project name:** something memorable
- **Agent name:** e.g. `jim-host`
- **Specialization:** `architect` or whatever fits

After this, `~/.config/relai/config.json` holds your per-agent token. The admin secret is no longer needed for day-to-day calls.

If you also want to drive relai from this machine via Claude Code (recommended), copy the printed MCP snippet into your project's `.mcp.json`.

## 4. Host side — invite your coworker

```bash
relai project invite \
  --name <coworker-suggested-name> \
  --specialization writer \
  --ttl 86400
```

It prints a single line:

```
relai login --invite inv_<base64url>
```

Send that whole line to your coworker — plus the **public API URL** from step 2. They need both. The invite is single-use and expires when `--ttl` says (default 7 days).

## 5. Coworker side — install + log in

```bash
npm install -g @getrelai/cli

# Run the line you sent them
relai login --invite inv_<...> --api <PUBLIC_API_URL>
```

Prompts:
- **Agent name:** their choice (the suggestion you set is the default)
- **Specialization:** their choice

This creates an agent record in your project, mints a per-agent token for them, and writes `~/.config/relai/config.json` on their machine. They never see your admin secret.

## 6. Coworker side — wire up MCP

`relai login` prints a ready-to-paste `mcpServers` block at the end of step 5. Drop it into their project's `.mcp.json` (or `~/.claude.json`). The `npx @getrelai/mcp-server` command pulls the package from npm — no clone required for the MCP server itself.

Restart their MCP client. Confirm via `/mcp` (or equivalent) that `relai` shows as connected with 10 tools.

## 7. Try the actual coordination

In your Claude Code session (host):

```
You: Use the relai tools to create a task in this project titled "Audit the
auth flow" with description "Walk the new per-agent token path end-to-end
and flag anything weird." Assign it to <coworker's agent id>.
```

In their session (coworker):

```
Coworker: Use the relai tools to check my unread messages and pending tasks.
```

Things to verify in this round-trip:
- The task shows up for them.
- A reply via `send_message` shows up for you.
- The web dashboard at `http://localhost:5173` (host only) shows both agents and the task.
- If you have time: `curl -N -H "Authorization: Bearer <your-token>" <PUBLIC_API_URL>/events` — you should see a stream of `event:` lines as activity happens.

## 8. Tear-down

```bash
# Host
relai token revoke <coworker's token id>   # optional
docker compose down                                                  # stops Postgres

# Coworker
rm ~/.config/relai/config.json
# Remove the relai entry from their .mcp.json
```

## Solo test (fake the second person)

If you don't have a real coworker on hand, you can play both sides from the same machine. The CLI honors `RELAI_CONFIG_DIR` so two terminals can hold different agent identities side by side.

```bash
# Terminal A — "host" identity, default config dir
relai init
# … walk through prompts, create project, register as e.g. "jim-host"
relai project invite --name fake-coworker --ttl 3600
# Copy the printed `relai login --invite ...` line.

# Terminal B — "coworker" identity, separate config dir
export RELAI_CONFIG_DIR=/tmp/relai-coworker
relai login --invite inv_<...> --api http://localhost:3010
# Walk through the prompts as the imaginary coworker.
```

You skip the public-URL step entirely; both sides talk to `http://localhost:3010`.

From here:
- Use `relai tasks`, `relai send`, `relai inbox` from either terminal — each sees the world from its own agent's perspective.
- For MCP-from-Claude-Code-as-the-coworker, point your MCP `.mcp.json` env at the coworker's `apiToken` / `agentId` from `/tmp/relai-coworker/config.json`. Restart Claude Code; you're now driving relai as the coworker agent.
- Watch events from one identity while acting from the other: `curl -N -H "Authorization: Bearer <coworker-token>" http://localhost:3010/events` in a third terminal — you should see SSE lines as terminal A sends messages.

This validates the full auth + invite + per-agent-token + event-fan-out path; only thing it doesn't validate is the actual cross-machine networking (so don't skip a real two-person test before going further with the design).

## Solo test, multi-identity via git worktrees (closer to a real two-person setup)

`RELAI_CONFIG_DIR` isolates the CLI config but **doesn't isolate `.mcp.json`** — every Claude Code session opened in this checkout reads the same project-level `.mcp.json` and so picks up the same agent token. Worker processes also share the working tree, so file edits race.

Git worktrees fix this without needing a second machine. Each identity gets its own checkout (own `.mcp.json`, own working tree) but everyone hits the same shared API and DB.

```bash
# Host identity stays in the main checkout (this directory).
# Already done: relai init, API running on localhost:3010, .mcp.json written.

# Create a separate checkout for each fake coworker. Cheap — shares git objects.
git worktree add ../relai-bob
git worktree add ../relai-carol
```

Then for each worktree, run the login + MCP wiring **inside that worktree's directory**:

```bash
cd ../relai-bob

# Optional but recommended: keep their CLI config separate too, so `relai` from
# this terminal won't see the host's identity if you cd around.
export RELAI_CONFIG_DIR=$PWD/.relai-config

# Get an invite from the host terminal:
#   (in main checkout) relai project invite --name bob --ttl 3600
relai login --invite inv_<...> --api http://localhost:3010

# Paste the printed mcpServers block into THIS worktree's .mcp.json.
# Because Claude Code resolves .mcp.json from the project root it's launched in,
# starting `claude` from ../relai-bob picks up Bob's token; from the main
# checkout it picks up the host's token. No collision.
```

You don't need to repeat `pnpm install`, `docker compose up`, or `db:push` — they're either shared (DB, node_modules via pnpm) or already done. You also don't need a second `pnpm --filter @getrelai/api dev` — there's still one API, and every worktree talks to it on `localhost:3010`.

Caveats:
- **Shared node_modules**: pnpm hoists into the main checkout's `node_modules`. Worktrees inherit it via the workspace. If you run `pnpm install` from a worktree it'll create a sibling `node_modules` and waste disk; just don't.
- **Shared dist artifacts**: `pnpm --filter @getrelai/cli build` writes to `packages/cli/dist` in whichever worktree you run it from. Build once in the main checkout, then run the CLI from each worktree via the same dist path (or symlink).
- **Worker processes**: a `claude-worker` started in `../relai-bob` will edit files in that worktree's tree — that's the whole point. Just don't have two workers from different worktrees touching the same branch.
- **Branch collisions**: each worktree must be on its own branch. `git worktree add ../relai-bob` creates one automatically; don't `git checkout main` inside it.

Tear-down:

```bash
git worktree remove ../relai-bob
git worktree remove ../relai-carol
```

This is the closest you can get to a real two-person test without a second machine: each "person" sees the world through their own checkout + their own MCP identity, and only the API/DB are shared (which is exactly what would happen across machines anyway).

## Things to capture during the test

Real friction is the point. Note (somewhere — a thread in relai itself works):
- Any step where the runbook was wrong or unclear.
- Any prompt that asked something the user couldn't answer.
- Whether "humans optional" actually holds — did the coworker want notifications, or was checking via Claude Code fine?
- Did `--to <agentId>` feel usable, or do we need a friendlier handle?
- Anything that felt obviously slow, redundant, or surprising.

Feed the findings back into the design doc at
`~/.claude/projects/-Users-jim-PhpstormProjects-relai/memory/project_cli_design.md`.
