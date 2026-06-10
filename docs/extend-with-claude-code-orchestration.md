# Extending relai with Claude Code orchestration patterns

## 1. Summary

relai is already a working multi-agent control plane: a single Postgres-backed hub with a propose→commit→route→verify task lifecycle, hub-and-spoke agent messaging, an in-process scheduler, per-agent tokens, and an MCP tool surface that any Claude/Copilot worker pulls work from. The Claude Code orchestration patterns proven this session (review-fix-loop and specialist-team) are not a competing control plane: they are *execution recipes* that run inside a single worker session. The right move is to treat relai as the distributed substrate that **dispatches** these recipes as first-class job types, persists their intermediate state (verdicts, patches, partitions) as relai tasks/threads/metadata, and maps their human gate (no-push) onto relai's existing verification/review states. relai gains structured multi-step workflows it lacks today; the Claude Code patterns gain durability, cross-machine fan-out, audit, and a human approval gate they cannot provide on their own.

## 2. How relai works today

The unit of work is a **task** with a propose-vs-commit state machine: `proposed → pending → assigned → in_progress → pending_verification → completed | blocked | cancelled` (enum in `packages/db/src/schema.ts`; lifecycle driven by `packages/api/src/routes/tasks.ts` plus the scheduler). A worker-authored task lands inert in `proposed` with a suggested assignee hint; an orchestrator commits or rejects it via `POST /tasks/:id/commit` before it can be routed.

**Routing** is a deterministic in-process scheduler (`packages/api/src/lib/router/scheduler.ts`, started from `packages/api/src/server.ts` ~line 47, ticking every `TASK_POLL_MS`≈15s). Each tick scans per repo for: pending+autoAssign tasks (`routePendingTasks` → `tryRulesRouting` in `packages/api/src/lib/router/rules.ts`, free, falling back to `claudeRouting` in `packages/api/src/lib/router/claude.ts`, paid), blocked tasks awaiting a human reply, overdue proposals, stalled in_progress tasks, and `pending_verification` rows.

**Verification** gates completion. When a worker PUTs `status: completed` and the task has a `verifyKind`, the task rewrites to `pending_verification` and the scheduler runs the predicate on the next tick. Four kinds exist in the `VERIFIERS` map (`scheduler.ts` ~line 251): `shell` (orchestrator-authored only, 60s timeout, 8KB output cap), `file_exists`, `thread_concluded`, `reviewer_agent` (emits `task.review_requested`; the reviewer resolves via `POST /tasks/:id/review`). Concurrent verification claims are guarded by optimistic CAS on `tasks.verifyingAt`, with 5-minute stuck-claim reaping.

**Coordination state** lives entirely in Postgres (`packages/db`): `tasks`, `threads` (operational `type=null` or `type='plan'` Epics), `messages` (typed: status/handoff/finding/decision/question/escalation/reply, read-tracked), `subscriptions` (who gets notified), `events` (persistent mirror of the in-process bus, fanned to SSE `GET /events`), plus `routing_log` and `verification_log`. Task context flows across a worker chain entirely through `tasks.metadata` JSONB — `branchName`, `roundNumber`, `parentTaskId`, `findings[]`, `prUrl`, `blockedThreadId`, `humanReply`.

**Workers** are stateless pull drones (`packages/claude-worker`). The loop: heartbeat → `GET /session/start` / `get_my_tasks` → for each assigned task, spawn an ephemeral Claude CLI session with a fresh stdio MCP server (`packages/mcp-server`, the 13 tools in `tools.ts`) bound to `REPO_PATH` → parse stream-json → mark status. A writer→reviewer→tester chain is orchestrated *only* through metadata and task creation — there is no worker-to-worker RPC. Each worker owns one local git clone and (per `packages/claude-worker/src/prompt.ts`) does `git checkout -b {branchName}` — **not** worktrees — so parallel sessions on one machine share and can collide on that clone.

The defining constraints: the scheduler is single-instance (SPOF, no leader election); there is **no task-dependency DAG** (only `epicId`/`parentTaskId` back-refs); verification is strictly **1:1 task→predicate** (no AND/OR composition); and all agents in a repo see all tasks (no sub-repo ACLs).

## 3. Capability table

| Claude Code pattern | Classification | Detail |
|---|---|---|
| **Workflow tool** (deterministic JS orchestrator: fan-out subagents, schema-validated outputs, budgets, resume) | **NEEDS ADAPTATION** | relai's scheduler is a *router*, not a *workflow engine*. It dispatches one task at a time and has no DAG, no fan-out/join, no structured-output contract, no budget accounting. Adapt: model a workflow as an Epic thread + a parent task whose `metadata.workflow` carries the step graph; each step is a child task. relai supplies durability/resume that the in-memory JS orchestrator lacks. |
| **Parallel/pipeline subagent fan-out** | **RELAI ALREADY SOLVES (the dispatch)** + **GAP (the join)** | Fan-out = create N child tasks routed to N workers; relai already does parallel per-repo dispatch. What relai lacks is the **join/barrier**: no way to gate a task until N siblings complete. Add a `tasks_completed` verification kind or a dependency edge (see §4). |
| **Structured (schema-validated) step outputs** | **GAP** | relai passes free-form `metadata` JSONB and free-text messages. No schema contract on a `finding`/`decision` payload. Add an optional `outputSchema` on a task and validate the completion payload. |
| **review-fix-loop** (5 personas + lead → structured verdict → mechanical-only fixer → re-review, until APPROVE/max) | **NEEDS ADAPTATION** | The review step ports onto `reviewer_agent` verification + the existing `finding`/`decision` message types. The *loop* (re-review until APPROVE or max iterations) needs a bounded controller — relai has `roundNumber` in metadata but nothing enforces a cap or re-queues automatically. See §4. |
| **specialist-team** (triage → disjoint file-ownership partition → per-specialist worktree → consolidator applies patches in order → verify) | **NEEDS ADAPTATION** | Triage = a parent task producing a partition manifest; each partition = a child task to a specialized worker (relai routes by `specialization`/`domains` already). The gaps: workers use `git checkout -b`, not isolated worktrees (clone collision), and there is no **consolidation/serialization point** as a first-class state. See §4 + §5. |
| **Per-agent model override** | **RELAI ALREADY SOLVES** | Worker honors `MODEL`/`CLAUDE_MODEL` env (`packages/claude-worker/src/config.ts`); routing model is `ROUTING_MODEL`. Per-step model = set it on the child task's worker. No build needed beyond surfacing a `metadata.model` hint the worker reads. |
| **MCP-capable agents / ToolSearch on demand** | **RELAI ALREADY SOLVES** | Workers already spawn a stdio MCP server per session; adding tools is the documented extension hook (`packages/mcp-server/src/tools.ts` `buildTools()`). |
| **Pre-push review gate** (HEAD-keyed pass receipt, human/panel checkpoint, hook-enforced) | **NEEDS ADAPTATION** | relai already *stops before push* (workers push only in the writer prompt; verification gates completion). Map the gate to a terminal **`pending_verification` with `verifyKind=reviewer_agent`** (or a new `human_approval` kind) keyed to the consolidated branch HEAD. The HEAD-keyed receipt becomes a `verification_log` row + `metadata.approvedHead`. |
| **Worktree isolation** | **GAP (cross-machine) / NEEDS ADAPTATION (single-machine)** | Single machine: workers must switch from `git checkout -b` to self-managed `git worktree add --detach` (the pattern already does this for foreign repos). Cross-machine: becomes clone/branch-per-worker (§5). |
| **Subagents spawning subagents** (limit: one nesting level) | **RELAI ALREADY SOLVES (and exceeds)** | relai has no nesting limit — any task can create child tasks (`parentTaskId`), and children can create their own. relai is the natural home for the recursion the in-process pattern forbids. |
| **Agents are Claude-only (pattern limit)** | **RELAI ALREADY SOLVES** | `agents.workerType` enum (claude/copilot/cursor/…) + per-type prompts already make the worker pool heterogeneous. |

## 4. Concrete integration design

### 4.1 New job type: `workflow` (the orchestrator as a task tree)

A workflow is a **parent task** plus an **Epic thread** (`threads.type='plan'`, surfaced as Epic in the web UI). The step graph lives in `tasks.metadata.workflow`:

```
metadata.workflow = {
  kind: "review_fix_loop" | "specialist_team",
  maxIterations: 3,        // loop cap
  iteration: 0,            // controller-incremented
  steps: [...],            // declarative step graph
  partition?: {...},       // specialist-team file ownership manifest
}
```

Child tasks are linked via `parentTaskId` (already exists) and the Epic via `epicId`. This reuses the existing schema; the only new field is a JSONB sub-key, which is an explicit extension hook (`Task.metadata` JSONB, `packages/db`).

### 4.2 New scheduler watcher: `workflowController`

Add one watcher to `runCycle()` in `packages/api/src/lib/router/scheduler.ts`, alongside `routePendingTasks`/`verifyScheduler` (the documented "Scheduler extension" hook). It is the bounded, deterministic controller the JS workflow tool provides in-process — but durable. Per tick, for each workflow parent task:

- **Fan-out**: if a step is `ready` and unspawned, create its child tasks (`POST /tasks`, auto-committed by the orchestrator-owned controller so they skip `proposed`) routed by `specialization`/`domains`.
- **Join/barrier**: a step with `dependsOn: [stepIds]` only becomes `ready` when all dependency child tasks are `completed`. This is the missing dependency edge — store it in `metadata.workflow.steps[].dependsOn`, evaluated by the controller. (Lighter than a full DAG schema; scoped to within a workflow.)
- **Loop**: for `review_fix_loop`, on a re-review step the controller checks the latest review child's verdict (a `decision` message with structured payload). `APPROVE` → workflow completes; `REQUEST_CHANGES` and `iteration < maxIterations` → spawn a fixer child (mechanical-only) then a fresh review child, `iteration++`; `iteration == maxIterations` → set parent `blocked` with `metadata.blockedThreadId` so a human resolves (reuses the existing blocked→human-reply→resume path in `watchBlockedTasks`).

### 4.3 review-fix-loop mapping

- **Review step** = a child task with `verifyKind='reviewer_agent'`, or simpler, a child task whose worker runs the 5-persona panel and posts a single structured `decision` message (new payload schema `{ verdict, findings[] }`) to the Epic thread. The five personas stay *inside* one worker session (cheap, no extra relai tasks) — relai only sees the lead's verdict.
- **Structured verdict** = enforce a schema on the `decision` message payload. Add optional `outputSchema` validation in `POST /threads/:id/messages` (or on task completion) — new validation in `packages/api/src/routes/messages.ts` / `tasks.ts`.
- **Fixer** = a child task, `specialization` matching the repo, prompt restricted to mechanical findings; judgmental findings are surfaced as `finding` messages on the Epic, not auto-applied.
- **Stop-before-push** = the workflow never includes a push step; terminal state is `pending_verification` on the parent (see 4.5).

### 4.4 specialist-team mapping + patch flow

- **Triage** = parent's first child task; output is `metadata.workflow.partition` = `{ specialty → [owned file globs] }`, posted as a `decision` message.
- **Specialists** = one child task per partition, routed by `specialization`/`domains` (relai's rules router already matches these — `tryRulesRouting`). Each specialist works in its **own worktree** (see §5) and returns a **patch** (git diff) rather than pushing. The patch is the structured output: store it on the child task as `metadata.patch` (or, for size, a `file_exists`-verified artifact path / object-store URL referenced in metadata).
- **Consolidation** = a single child task with `dependsOn: [all specialist steps]` — the join guarantees all patches exist first. The consolidator worker applies patches **in partition order** (disjoint ⇒ conflict-free by construction) onto the workflow branch, then runs the verify command. This is the **serialization point**: exactly one consolidator task, one branch, applied in deterministic order.
- **Verify** = the consolidation task carries `verifyKind='shell'` (orchestrator-authored, so allowed) running the build/test command, gated by the existing `verifyingAt` CAS.

### 4.5 Pre-push gate → relai approval state

The consolidated, verified branch must not be pushed without human sign-off. Map this onto a **terminal approval task**:

- Parent workflow task transitions to `pending_verification` with `verifyKind='reviewer_agent'` (human reviewer is a registered `workerType='human'` agent) **or** a new `verifyKind='human_approval'` added to the `VERIFIERS` map (extension hook in `scheduler.ts`).
- The receipt is HEAD-keyed: store `metadata.approvedHead = <branch HEAD sha>` when the human approves via `POST /tasks/:id/review`. The approval is recorded in `verification_log` (command/exit-code analog), giving the audit trail relai otherwise lacks.
- Only after `task.verified` does any push/merge step run — and even that should be a separate, explicitly-committed task so the human gate is never auto-crossed. This makes relai's existing "verification gates completion" the enforcement mechanism the Claude Code hook provides locally.

### 4.6 New/changed surface summary

- **DB**: no new tables. New `metadata.workflow` / `metadata.patch` / `metadata.approvedHead` JSONB sub-keys; new `verifyKind` enum value `human_approval` (`packages/db/src/schema.ts` pgEnum). New `decision` payload schema validated app-side.
- **Scheduler**: `workflowController` watcher added to `runCycle()` (`packages/api/src/lib/router/scheduler.ts`); `human_approval` entry in `VERIFIERS`.
- **MCP tools** (`packages/mcp-server/src/tools.ts` `buildTools()`): `start_workflow` (create parent + Epic + seed `metadata.workflow`), `submit_patch` (write `metadata.patch` on a child), `report_verdict` (structured `decision`). Each maps to an `ApiClient` method (`api-client.ts`).
- **Worker** (`packages/claude-worker`): a `prompt.ts` specialization block per workflow role (triager, specialist, consolidator, panel-reviewer, fixer) that reads `metadata.workflow`; switch branch creation from `git checkout -b` to `git worktree add --detach`.
- **REST**: reuse `POST /tasks`, `/commit`, `/review`, `/threads/:id/messages`. Optional `outputSchema` validation on completion/message.

## 5. Distributed story

Single-machine, the specialist worktrees are exactly the proven pattern: each specialist worker does `git -C <repo> worktree add --detach <path>`, works its disjoint slice, and the consolidator applies patches into one working tree. The collision risk relai has today (all workers share `REPO_PATH` via `git checkout -b`, per `packages/claude-worker` gaps) is removed because each task gets its own worktree path.

**Cross-machine, worktree-per-specialist becomes clone/branch-per-worker.** Workers on different machines each own an independent clone (relai's current distribution model — "each worker has its own `REPO_PATH`", no shared storage). The translation:

- A worktree on machine A == a clone on machine B. The isolation guarantee is identical: disjoint file ownership means no two specialists touch the same paths.
- Patches travel as **data through relai**, not through git remotes: each specialist returns its diff in `metadata.patch` (or an artifact URL). This avoids needing every specialist to push a branch to origin and the consolidator to fetch N branches — the patch *is* the wire format, and relai's DB is the transport.
- The **consolidation/merge serialization point is a single relai task** (the `dependsOn`-gated consolidator), routed to exactly one worker on one machine. Because relai's scheduler is single-instance and routes one task per repo per cycle, there is a natural global serialization point — the consolidator runs alone, applies patches in partition order, pushes the single integration branch. No distributed merge, no leader election needed for the merge itself.
- If patches are large, fall back to branch-per-worker: each specialist pushes `feat/<workflow>-<specialty>` to origin, records the branch in `metadata.patchBranch`, and the consolidator (one worker, one machine) fetches and merges them in order. The serialization point is unchanged; only the transport differs.

The one thing that does **not** get solved by this design is scheduler HA: the consolidation serialization point depends on relai's single-instance scheduler. That is an existing relai gap (no leader election), not one this design introduces — but it does mean the merge point inherits the SPOF.

## 6. Phased rollout

1. **Structured outputs + verdict schema (smallest).** Add optional `outputSchema`/`decision`-payload validation and the `report_verdict` MCP tool. No scheduler change. Immediately useful on its own: any existing reviewer task can return a machine-checkable verdict.
2. **`human_approval` verification kind + HEAD-keyed receipt.** Add to `VERIFIERS` and `verifyKind` enum; record `approvedHead` in `verification_log`. Gives relai the pre-push gate as a durable state. Standalone valuable for *any* task, not just workflows.
3. **review-fix-loop as a workflow.** Add the `workflowController` watcher handling only `kind='review_fix_loop'` (loop + iteration cap + blocked-on-max). Reuses existing reviewer/fixer tasks. Single-machine.
4. **Dependency edge / join barrier.** Implement `dependsOn` evaluation in the controller (the `tasks_completed` join). Unlocks fan-out/join generally, not just for specialist-team.
5. **specialist-team, single-machine.** Triage → partition → worktree-isolated specialists → `dependsOn`-gated consolidator → shell verify → human_approval gate. Switch worker to `git worktree add`.
6. **Cross-machine specialist-team (last).** Patch-through-metadata transport (or branch-per-worker fallback), clone-per-worker, consolidator as the single serialization task.

## 7. Risks & open questions

- **Scheduler SPOF inherits the merge point.** The consolidation serialization relies on the single-instance scheduler (existing gap: no leader election in `scheduler.ts`). If we ever scale the API horizontally, the consolidator could double-run; we'd need a `verifyingAt`-style CAS claim on the consolidation task. Open: add a generic per-task claim lease now, or defer?
- **Patch size in `metadata` JSONB.** Large diffs bloat the `tasks` row and every `/session/start` snapshot that includes the task. Threshold for spilling to an artifact store / branch-per-worker? Where does the artifact store live (relai has none today)?
- **Partition correctness is assumed, not enforced.** "Disjoint file ownership ⇒ conflict-free" holds only if triage actually partitions cleanly. relai cannot verify a specialist stayed in its lane. Add a guard: consolidator rejects a patch touching files outside its partition (a `shell`/validation step), or accept best-effort + conflict surfacing?
- **Loop cost.** Each re-review is a fresh Claude worker session; `maxIterations` bounds it, but combined with Claude routing fallback this can be token-heavy. Should the controller prefer rules routing and a cheaper review model (`metadata.model`) by default?
- **Structured-output schema ownership.** Where do step output schemas live — hardcoded per workflow kind in the API, or declarable in `metadata.workflow`? Declarable is flexible but lets a worker define its own contract (trust boundary question).
- **Human-approval agent identity.** Using `workerType='human'` + `reviewer_agent` conflates "automated reviewer" and "human gate." Is a distinct `human_approval` verifyKind worth the enum churn for clarity, or is the reviewer path enough?
- **Mechanical-vs-judgmental split is a prompt heuristic.** The fixer's "apply only mechanical findings" boundary lives in prompt text, not enforced by relai. A fixer could over-reach. Do we need a structured `finding.severity`/`finding.mechanical` flag (already partially present in `findings[]`) that the controller, not the prompt, uses to decide what auto-applies?

## 8. Backlog items this closes or advances

Cross-referenced against the open items in `docs/relai-improvements.md`:

| Backlog item | Sev | This design | Effect |
|---|---|---|---|
| B — No native task dependency/DAG (`dependsOn`/`blockedBy`) | 🔴 | §4.2 join/barrier | **Closes** (Phase 4) |
| B — No formal human-approval gate (`verifyKind: human_approval`) | 🟡 | §4.5 | **Closes** (Phase 2) |
| B — No collision guard for concurrent same-file edits | 🟡 | §4.4 partition + out-of-partition patch rejection | **Closes** (Phase 5) |
| A — Task done while branch unpushed / no git-state awareness | 🔴 | §4.4 patch-through-metadata + §4.5 gate + §5 | **Closes** (Phases 2/5/6) |
| A — Single-orchestrator bottleneck / trusted-senior auto-commit | 🔴 | controller auto-commits orchestrator-owned child tasks | Advances (Phase 3) |
| C — Interactive agents stall mid-multi-step | 🟡 | `workflowController` re-queues the next step | Advances (Phase 3/4) |
| A/D — structured status / loud `create_task` / dedupe | 🟡 | §4 structured outputs (`outputSchema`, `report_verdict`) | Advances (Phase 1) |

### Dependency-ordered execution (do all, in this order)

Each step is its own PR, gated by the review-fix-loop panel. Ordering follows the build dependencies, not the backlog severity:

1. **Phase 1 — structured outputs** (`outputSchema`, `report_verdict`, `decision` payload schema). Foundation for the verdict contract; advances A/D. No scheduler change.
2. **Phase 2 — `human_approval` verifyKind + HEAD-keyed receipt.** Closes the B human-gate item; standalone, depends on nothing.
3. **Phase 3 — `workflowController` + `review_fix_loop`** (loop, iteration cap, blocked-on-max; orchestrator-owned auto-commit). Advances the A bottleneck + C stall items. Needs Phase 1's verdict schema.
4. **Phase 4 — `dependsOn` join edge.** Closes the B dependency-DAG 🔴; unlocks fan-out/join generally. Needs Phase 3's controller.
5. **Phase 5 — specialist-team, single-machine** (triage → partition → worktree specialists → `dependsOn` consolidator → shell verify → human_approval). Closes the B collision-guard item; needs Phases 2 + 4 and the worker switch to `git worktree add`.
6. **Phase 6 — cross-machine** (patch-through-metadata transport / branch-per-worker fallback; clone-per-worker). Finishes the A git-state 🔴; needs Phase 5.

Net over Phases 1–6: **closes 4 tracked items** (🔴 DAG, 🟡 human-gate, 🟡 collision-guard, 🔴 unpushed/git-state) and **advances 3 more**.
