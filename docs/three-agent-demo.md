# Three-agent demo: orchestrator + headless worker + reviewer

This runbook spins up a three-identity loop on one machine:

- **You** — orchestrator. You create tasks via `relai task create`.
- **A headless `claude-worker`** — implementer. Picks up assigned tasks and edits a clone of the repo.
- **A second human (or Claude in chat)** — reviewer. Approves or rejects via `relai task review`, gated by the new `reviewer_agent` verifier kind.

The point isn't production realism — it's a tight feedback loop that exercises `@auto` routing, the reviewer-agent verifier, the SSE event stream, and the worker prompt. Production-shaped concerns (PRs, branch hygiene, push auth) are deliberately skipped.

---

## Layout

| Identity   | Working directory                       | Config dir                          |
| ---------- | --------------------------------------- | ----------------------------------- |
| Orchestrator (you)  | `~/PhpstormProjects/relai` (this repo) | `~/.config/relai`                   |
| Worker     | `~/clones/relai-worker` (fresh clone)   | `~/.config/relai-worker`            |
| Reviewer   | anywhere (no repo needed)               | `~/.config/relai-reviewer`          |

The reviewer doesn't need a clone — they only need a CLI identity to call `relai task review`. They read diffs out of the **worker's** clone path directly (`~/clones/relai-worker`).

---

## One-time setup

### 1. API + DB running

```bash
docker compose up -d
pnpm --filter @getrelai/api dev   # port 3010
```

### 2. Orchestrator config

Already done if you've used relai locally. Otherwise:

```bash
relai init   # API URL = http://localhost:3010, paste API_SECRET
```

### 3. Issue invites for the worker and reviewer

From the orchestrator's terminal:

```bash
relai project invite -n claude-worker -s writer --ttl 1h
# → prints a code, e.g. inv_xxx

relai project invite -n claude-reviewer -s reviewer --ttl 1h
# → prints a second code
```

### 4. Worker identity + clone

```bash
git clone <this-repo> ~/clones/relai-worker
cd ~/clones/relai-worker
RELAI_CONFIG_DIR=~/.config/relai-worker \
  relai login --invite <worker-code> --api http://localhost:3010
```

### 5. Reviewer identity (no clone)

```bash
RELAI_CONFIG_DIR=~/.config/relai-reviewer \
  relai login --invite <reviewer-code> --api http://localhost:3010
```

Confirm: `RELAI_CONFIG_DIR=~/.config/relai-reviewer relai status` shows the reviewer agent.

---

## Run the loop

### Start the worker

In a dedicated terminal:

```bash
cd ~/clones/relai-worker
RELAI_CONFIG_DIR=~/.config/relai-worker \
  AGENT_ID=$(jq -r .agentId ~/.config/relai-worker/config.json) \
  PROJECT_ID=$(jq -r .projectId ~/.config/relai-worker/config.json) \
  CLAUDE_WORKER_SPECIALIZATION=writer \
  pnpm --filter @getrelai/claude-worker dev
```

The worker now polls `get_my_tasks` on its interval, spawning a fresh headless Claude session each tick.

### Create a reviewer-gated task

From the orchestrator (the main repo terminal):

```bash
# Confirm the worker and reviewer are visible in the project
relai agents

# Assign work to the worker, gate completion on the reviewer's approval.
# --to and --verify-reviewer accept either an agent id or a name.
relai task create \
  -t "Verifier registry refactor" \
  -d "Collapse scheduler verifier dispatch into a registry keyed by verifyKind." \
  --to claude-worker \
  --verify-kind reviewer_agent \
  --verify-reviewer claude-reviewer
```

### Watch the loop

- **Orchestrator** — `relai tasks --all` to see status; `relai inbox` for any escalations.
- **Worker** — its terminal streams the headless Claude session: tool calls, stdout, completion.
- When the worker calls `update_task_status → completed`, the API rewrites it to `pending_verification` and emits `task.review_requested`. The reviewer is auto-subscribed.

### Submit the review

The reviewer reads the diff directly out of the worker's clone:

```bash
cd ~/clones/relai-worker
git diff main      # or whatever base branch the worker created from
```

Decide, then:

```bash
RELAI_CONFIG_DIR=~/.config/relai-reviewer \
  relai task review <task-id> --decision approve

# or
RELAI_CONFIG_DIR=~/.config/relai-reviewer \
  relai task review <task-id> --decision reject \
  --note "missing tests for the misconfigured-row branch"
```

On the next scheduler tick (≤15s), the task transitions:

- **approve** → `completed`, `task.verified` event.
- **reject** → `assigned`, `task.verification_failed` event with the note in `metadata.lastVerification`. The worker picks it back up next poll.

---

## Caveats

- `claude-worker` runs with `--dangerously-skip-permissions`. Fine in a clone, **never** point it at a tree you can't blow away.
- Read the worker's tree only when the task is in `pending_verification` (a quiescent moment). Reading mid-edit risks reviewing half-written code.
- The reviewer specialization in `claude-worker` knows about `submit_review` (see `packages/claude-worker/src/prompt.ts`), so this loop also works with a Claude-as-reviewer setup — replace the human reviewer with another `claude-worker` registered with `CLAUDE_WORKER_SPECIALIZATION=reviewer`.
