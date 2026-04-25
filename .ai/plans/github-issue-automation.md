# Planned Change: GitHub Issues as Automated Task Source

## Vision

Turn the orchestrator into an automated repo maintainer:

1. Human opens a GitHub issue with label `ai-task`
2. Orchestrator polls GitHub (derived from `project.repoUrl`) and imports it as an internal task
3. Task routes to **Copilot** (tier-1) as intake agent
4. Copilot triages:
   - **No code needed** (doc fix, clarification, already fixed, invalid) → handles directly, posts comment, closes issue
   - **Code needed** → writes a spec, creates a code task via `create_task` MCP tool, marks self complete
5. Orchestrator sync loop detects the new code task has `branchName` set + `githubInProgressNotified` absent → posts "branch created" comment on GitHub issue, adds `ai-in-progress` label
6. Claude works the code task on the named branch, commits, creates PR, marks complete
7. Claude creates a review task back to Copilot via `create_task`, passing branch + PR metadata
8. Copilot reviews:
   - **Clean** → completes with `spawnOnComplete: { githubIssueNumber, githubRepo, outcome }`
   - **Issues found** → creates a fix task back to Claude with structured `findings`; round trips continue
9. Orchestrator sync loop detects terminal task with `spawnOnComplete` → posts outcome comment, swaps labels, closes issue
10. A `maxRounds` guard prevents runaway loops — after N rounds, escalates to a human thread

No human input required after the issue is created.

---

## Architectural Decisions

### Project = single repository

A project maps 1:1 to a GitHub repository. `project.repoUrl` is the canonical remote URL (e.g. `https://github.com/org/repo`) and is **required** (not nullable).

Consequences:
- `GITHUB_REPOS` env var is eliminated — the orchestrator derives `owner/repo` from `project.repoUrl`
- `create_task` is project-scoped; agents cannot create tasks in other projects
- GitHub sync loop reads `project.repoUrl` directly via `getProject(projectId)` — no separate repo config needed

`repoUrl` is the remote URL. `REPO_PATH` in copilot-worker remains a local agent env var — different agents may have the repo cloned at different local paths.

Schema change: make `projects.repoUrl` NOT NULL; require it on `POST /projects`.

### Shared repository requirement

All agents (Copilot worker and Claude Code instances) in a project must have the **same git repository checked out on disk**. The branch name is the coordination primitive — agents check out the shared branch, read prior work, push new commits. This is a hard architectural constraint.

`REPO_PATH` in copilot-worker config and the working directory of each Claude Code session must point at the same repo clone.

---

## Coordination Model

### Branch as the shared workspace

`branchName` is set when the first code task is created and travels in metadata through every downstream task. Every agent in the chain:
1. Reads `branchName` from task metadata
2. Checks out that branch
3. Does its work
4. Pushes commits
5. Creates the next task (explicitly, via `create_task`) with `branchName` propagated

The branch name — not the task ID — is the handoff interface.

### Multi-round handoff via `create_task` MCP tool

Agents explicitly create follow-up tasks. Each task in the chain is discrete, named, and traceable:

```
intake/task_001  → "Triage: Issue #7 — add dark mode"
code/task_002    → "Implement: dark mode toggle (branch: feat/issue-7)"
review/task_003  → "Review: PR for feat/issue-7"
fix/task_004     → "Fix: failing contrast tests on feat/issue-7"
review/task_005  → "Re-review: feat/issue-7 after contrast fix"
                    └─ clean → spawnOnComplete → orchestrator closes issue
```

`spawnOnComplete` is retained only for the final orchestrator-owned GitHub close. All agent-to-agent handoffs use `create_task`.

### `maxRounds` guard

Each task in a chain carries `metadata.roundNumber` (incremented on each `create_task` call). If `roundNumber >= maxRounds` (default 5), the agent sends an escalation message to the orchestrator thread instead of creating another task.

---

## New Primitives Required

### 1. `sourceRef` column on `tasks`
Dedup key for GitHub-imported tasks. Format: `"github:{owner}/{repo}#{number}"`. Nullable text. Checked before import.

### 2. `parentTaskId` column on `tasks`
Nullable self-referential FK. Traces the full chain of related tasks. Exposed in `get_my_tasks` MCP output so agents can traverse the chain.

### 3. `create_task` MCP tool (new)
Allows agents to explicitly create follow-up tasks. Always scoped to the agent's own project — `projectId` is injected server-side from agent config, agents cannot override it.

```typescript
{
  title: string,
  description: string,
  specialization?: string,
  domains?: string[],
  priority?: "low" | "normal" | "high" | "urgent",
  metadata?: Record<string, unknown>,  // branchName, roundNumber, findings, etc.
  parentTaskId?: string,
}
```

Returns `{ taskId: string }`. Handler calls `POST /tasks` with `createdBy` = agent's own ID.

### 4. `spawnOnComplete` metadata (narrow, final-step only)
Only the final clean-review task sets this. Orchestrator detects terminal tasks with `metadata.spawnOnComplete` present, posts GitHub outcome comment, swaps labels, closes issue.

**Critical**: the close trigger is `metadata.spawnOnComplete` presence — NOT `metadata.githubIssueNumber`. Every task in the chain carries `githubIssueNumber` for traceability, but only the final task sets `spawnOnComplete`. Using `githubIssueNumber` as the trigger would close the issue the moment the first code task completes.

---

## Handoff Metadata Contract

Every task in a chain carries this standard shape:

```json
{
  "branchName": "feat/issue-7",
  "roundNumber": 2,
  "githubIssueNumber": 7,
  "githubRepo": "org/repo",
  "githubIssueUrl": "https://github.com/org/repo/issues/7",
  "githubIssueSourceRef": "github:org/repo#7",
  "prUrl": "https://github.com/org/repo/pull/42"
}
```

`branchName` and `githubIssue*` propagate from the first task forward. `prUrl` is added when Claude opens a PR. `roundNumber` starts at 1 on the first code task and increments each time an agent calls `create_task` for a follow-up.

---

## Review Findings Format

When Copilot creates a fix task after finding issues, it populates `metadata.findings`:

```json
{
  "findings": [
    {
      "type": "test_failure",
      "severity": "blocking",
      "description": "AuthService.test.ts line 42: expected 401, got 200. Token validation not checking expiry."
    },
    {
      "type": "lint",
      "severity": "advisory",
      "description": "no-unused-vars: src/auth.ts line 17, variable `decoded` declared but never read."
    }
  ]
}
```

**`type` enum**: `test_failure | lint | type_error | build_error | logic_error | security | style`

**`severity` enum**: `blocking | advisory`

### Findings-based routing (in `packages/orchestrator/src/router/rules.ts`)

`metadata.findings` is treated as an additional routing signal alongside `specialization` and `domains`. The router reads it during the routing cycle — no other layer interprets findings:

- Any finding with `type: "security"` → prefer `architect` specialization
- Any `severity: "blocking"` → elevate to `high` priority if currently `normal`
- All findings `severity: "advisory"` only → keep existing priority

`task.metadata` is already typed as `Record<string, unknown>` and accessible in `tryRulesRouting()` — no function signature changes needed.

---

## Mid-Flight GitHub Visibility

Handled entirely by `runGithubSyncCycle` — no message plumbing required.

**"Branch created" notification** (Gap 2 fix): Each sync cycle, after importing new issues, also scans `in_progress`/`assigned` tasks with `metadata.branchName` set and `metadata.githubInProgressNotified !== true`:
1. Post comment: "Branch `{branchName}` created, working on this now"
2. Add `ai-in-progress` label
3. Patch `metadata.githubInProgressNotified: true`

This fires once per task naturally — the `githubInProgressNotified` flag prevents refire. No dependency on Copilot sending any particular message type.

**On issue close** (handled by `runSpawnAndSyncCycle`): remove `ai-in-progress`, add `ai-done`, close issue.

> **Why not message-based?** The message loop ignores `status`-type messages (`message-loop.ts:115-118`). Adding GitHub side-effects to message handling would mix concerns. The sync loop already has the GitHub client and runs on the right interval.

---

## Schema Changes

### `shared/db/src/schema.ts`

```typescript
// tasks table — add:
sourceRef:    text("source_ref"),
parentTaskId: text("parent_task_id").references((): AnyPgColumn => tasks.id),

// projects table — make repoUrl required:
repoUrl: text("repo_url").notNull(),  // was nullable
```

Import `AnyPgColumn` from `drizzle-orm/pg-core`.

Migration: `DATABASE_URL=... pnpm --filter @ai-orchestrator/db db:push`

---

## New Files

| File | Purpose |
|---|---|
| `packages/orchestrator/src/github-client.ts` | Octokit wrapper + `parseLabels()` |
| `packages/orchestrator/src/github-sync.ts` | `runGithubSyncCycle` + `runSpawnAndSyncCycle` |

---

## Modified Files

| File | Change |
|---|---|
| `shared/db/src/schema.ts` | `source_ref`, `parent_task_id` on tasks; `repo_url` NOT NULL on projects |
| `packages/api/src/routes/tasks.ts` | Accept `sourceRef`/`parentTaskId` on create; `sourceRef` filter on GET |
| `packages/api/src/routes/projects.ts` | Require `repoUrl` on `POST /projects` |
| `packages/mcp-server/src/tools.ts` | Add `create_task`; add `parentTaskId` to `get_my_tasks` output |
| `packages/mcp-server/src/tools.test.ts` | Tests for `create_task`; updated `get_my_tasks` snapshot |
| `packages/orchestrator/src/router/rules.ts` | Read `metadata.findings` for security override + priority elevation |
| `packages/orchestrator/src/config.ts` | Remove `GITHUB_REPOS`; add `GITHUB_TOKEN`, `GITHUB_LABEL`, `GITHUB_SYNC_INTERVAL_MS`, `MAX_TASK_ROUNDS` |
| `packages/orchestrator/src/api-client.ts` | Add `getProject()`, 3 new task methods, updated types |
| `packages/orchestrator/src/index.ts` | Wire GitHub sync loops |
| `packages/copilot-worker/src/prompt.ts` | Intake triage + multi-round handoff + findings format + maxRounds guard |
| `packages/orchestrator/package.json` | Add `@octokit/rest` |
| `scripts/seed.ts` | Accept optional `repoUrl` arg (default placeholder for local dev) |
| `scripts/demo.ts` | Accept optional `repoUrl` arg (default placeholder for local dev) |
| `.env.example` | Document new vars; remove `GITHUB_REPOS` |

---

## New Environment Variables

| Variable | Default | Notes |
|---|---|---|
| `GITHUB_TOKEN` | — | Sync disabled if absent; needed by orchestrator |
| `GITHUB_LABEL` | `ai-task` | Label to filter issues |
| `GITHUB_SYNC_INTERVAL_MS` | `60000` | Poll interval in ms |
| `MAX_TASK_ROUNDS` | `5` | Max handoff rounds before human escalation |

`GITHUB_REPOS` removed — repo URL derived from `project.repoUrl`.
`GITHUB_TOKEN` already exists in copilot-worker; orchestrator needs its own copy in `.env`.

---

## Polling Loops (orchestrator)

**Existing (unchanged):**
- Task routing: 15s
- Message routing: 10s
- Heartbeat: 60s

**New:**
- `runGithubSyncCycle`: 60s — imports open issues; posts "branch created" notifications on in-progress tasks
- `runSpawnAndSyncCycle`: 60s — closes issues on terminal tasks with `spawnOnComplete`

Both new loops are no-ops if `GITHUB_TOKEN` is unset.

---

## GitHub Sync — Inbound + Notifications (`runGithubSyncCycle`)

**Part A — Import new issues:**
1. Call `getProject(config.projectId)` to get `repoUrl`; parse into `owner/repo`
2. Fetch open issues with `config.githubLabel`
3. Build `sourceRef = "github:{owner}/{repo}#{issue.number}"`
4. Check `GET /tasks?sourceRef=...` — skip if already imported
5. Map labels: `domain:X` → `domains:["X"]`, `spec:X` → `specialization:"X"`
6. `POST /tasks` — routes to Copilot (tier-1) automatically

**Part B — "Branch created" notifications:**
1. Fetch `assigned`/`in_progress` tasks with `metadata.branchName` set and `metadata.githubInProgressNotified !== true`
2. For each: post comment, add `ai-in-progress` label, patch `githubInProgressNotified: true`

## GitHub Sync — Outbound Close (`runSpawnAndSyncCycle`)

Trigger: terminal tasks where `metadata.spawnOnComplete` is present and `metadata.githubSynced !== true`.

1. Extract `githubIssueNumber` and `githubRepo` from `metadata.spawnOnComplete`
2. Post outcome comment (`spawnOnComplete.outcome` or status default)
3. Remove `ai-in-progress` label, add `ai-done`
4. Close issue
5. Patch `metadata.githubSynced: true`

---

## Orchestrator API Client Additions (`packages/orchestrator/src/api-client.ts`)

- `getProject(projectId)` → `GET /projects/:id` — needed by sync loop to get `repoUrl`
- `getTaskBySourceRef(projectId, sourceRef)` → `GET /tasks?projectId=...&sourceRef=...`, first match or `null`
- `getTerminalTasks(projectId)` → `GET /tasks?projectId=...&status=completed,cancelled`
- `updateTask(taskId, patch)` → generic `PUT /tasks/:id`

Add `sourceRef` and `parentTaskId` to `createTask()` body type and `TaskRow`.

---

## Copilot Prompt Additions (`packages/copilot-worker/src/prompt.ts`)

**A. GitHub intake triage**
When `metadata.githubIssueUrl` present: decide code-needed or not.
- Not needed: handle directly, complete with `spawnOnComplete: { githubIssueNumber, githubRepo, outcome }`
- Needed: call `create_task` with full spec + all propagated metadata (including `branchName` once determined); mark self complete. The orchestrator sync loop handles the "branch created" GitHub comment — Copilot does not post anything to GitHub directly.

**B. Multi-round review rules**
- On code task completion: call `create_task` for review task, set `roundNumber: (inherited ?? 0) + 1`
- On finding issues: call `create_task` for fix task with `metadata.findings` array; increment `roundNumber`
- If `roundNumber >= MAX_TASK_ROUNDS`: send escalation message — do NOT call `create_task`

**C. Findings format**
When creating a fix task, populate `metadata.findings`. Each entry needs `type`, `severity`, `description`. Description must be specific: file, line, expected vs. actual where applicable.

**D. Final close sequence**
When review is clean: complete with `spawnOnComplete: { githubIssueNumber, githubRepo, outcome: "..." }`. Do not call `create_task`. The orchestrator handles the GitHub API close.

---

## Scripts (`scripts/seed.ts`, `scripts/demo.ts`)

Both scripts create projects without `repoUrl` today. Making `repoUrl` NOT NULL breaks them.

Fix: add an optional positional arg (or env var `REPO_URL`) to both scripts. Default to `https://github.com/example/placeholder` when not provided — safe because GitHub sync is disabled without `GITHUB_TOKEN`, so the placeholder is never actually called.

Example seed usage after change:
```bash
API_SECRET=changeme tsx scripts/seed.ts my-project orchestrator orchestrator https://github.com/org/repo
```
