# Threading model: plans, tasks, and where conversation lives

Design note exploring why the edgefinder run produced one "monster" plan thread,
and what the right conversation model is. Written 2026-05-31.

## The question

During the multi-agent run, nearly all communication (handoffs, review verdicts,
escalations, status, scope directives, the Phase-3 HALT) flowed through a single
plan thread. Was the cause the missing `create_task` tool? And is the envisioned
model sound?

Envisioned model:
1. **Plans** are conversations, open to input from anybody.
2. On **conclusion**, tasks are created from the plan.
3. From there, **tasks have their own threads**.

## Verdict

`create_task` was **not** the root cause. It removed one category of plan-thread
traffic (the architect describing tasks so the coordinator could create them),
but the handoffs, reviews, status, and HALT were never about creating tasks. They
piled into the plan thread because **a task has no conversation surface**, and the
plan thread was the only venue everyone was already subscribed to. Path of least
resistance wins.

The envisioned model is the right shape. It needs three refinements:

1. It is too waterfall. Execution feeds back into planning, so the lifecycle is a
   **cycle, not a line**.
2. The hard part is not the structure, it is **subscription/visibility**. That is
   the lever that decides whether task threads actually drain traffic away from
   the plan thread.
3. Tasks need a **provenance link** back to the plan that spawned them.

## Update (2026-05-31): the UI reframe and the Epic → Issue decision

Looking at the running dashboard, the model was not flowing. The diagnosis is
concrete: the web nav has **three top-level tabs (Tasks, Plans, Threads) backed by
two tables**, one of which (`threads`) is artificially bisected by a flag (Plans =
`type === "plan"`, Threads = `type !== "plan"`). And the Plans page already spawns
a task per invited agent that points back at the plan via
`metadata.planThreadId`, so the cross-link this doc wanted exists informally, with
no first-class home. Three surfaces for what is one spectrum of work is the actual
source of the friction.

This reopens the alternative this doc earlier rejected ("collapse task and thread
into one entity"). The rejection was too quick. This doc's own conclusion already
said deliberation-vs-commitment is a **state transition, not two entity types**;
keeping two tables anyway was an inconsistency. The resolution separates two
questions that were being conflated:

- **Presentation: should it be ONE surface?** Yes, unambiguously. Three tabs for
  one spectrum is the bug.
- **Storage: one table, or two tables linked?** Genuinely open. The single
  unified surface can sit on top of either. The honest risk of a hard merge is a
  god-table where `assignee`/`status`/`verify` are all nullable during the
  discussion phase and invariants move from the schema into app code; two
  tightly-scoped tables with a clean link keep each lifecycle's rules honest.

So the path is staged:

- **Path A (do first, cheap, reversible):** keep `tasks` + `threads`, make the
  link first-class (`task.threadId` / `thread.taskId`), collapse Plans+Threads,
  and present one unified surface where an Issue renders with its thread inline as
  comments. Tests whether the unified mental model flows, with no migration to
  unwind.
- **Path B (only if A proves it):** merge into one entity with a `phase` column.
  Touches all tables, every route, MCP, CLI, web. Justified only if the two-table
  seam keeps leaking into the UX after living with A.

### Vocabulary (locked 2026-05-31)

The naming family is **Epic → Issue** (operator comes from a Jira background; both
terms are also well-represented in LLM training data, so the agent half of the
audience is equally served).

- **Epic** = the deliberation + container layer (today's plan thread). **Gets its
  own top-level surface.** Open, broad-audience, spawns Issues, holds
  cross-cutting decisions.
- **Issue** = one work item across all phases: `proposed → assigned → in_progress
  → in_review → done`. (Today's task. "Issue" is used the GitHub way: the concrete
  unit, stable across both naming schemes we considered.)
- **Comments** = the conversation (today's messages), attached to any Issue or
  Epic. This is where the per-task thread lands: an Issue's comments are its
  thread.
- **`proposed`** stays the name of the pre-commit phase (the propose-vs-commit
  work already shipped this state). Propose → commit IS the triage step that turns
  an untriaged Issue into owned work.

Two guardrails on the choice:

1. **Do not import Jira's type hierarchy.** Adopt the word "Epic" for the
   container, not the Epic/Story/Task/Sub-task/Bug taxonomy. Keep it two levels
   (Epic + Issue; add "Sub-issue" only if real depth is ever needed). One entity
   with phases, not five issue-types. This preserves the recursive "plans spawn
   plans" tree rather than fixing it at Jira's levels.
2. **"Epic" underplays the open-deliberation nature, so the surface must carry
   it.** The value of the old plan layer was that it was an open, broad-audience
   RFC. The Epic surface must still afford comments + broad subscription +
   "anyone can weigh in," or the Jira "Epic = static planning bucket" mental
   model will quietly strip the deliberation behavior the term does not advertise.

### Term mapping

| Today | Becomes |
|---|---|
| Plans tab + Threads tab (`threads` split by `type`) | **Epics** (own surface) + Comments folded onto Issues |
| Tasks tab (`tasks`) | **Issues** |
| messages | **Comments** (on an Issue or Epic) |
| `task.metadata.planThreadId` (informal) | first-class Epic → Issue parent link |
| propose → commit | triage: untriaged Issue → owned Issue |

## Why the monster thread really happened

Three forces, in order of importance:

1. **Tasks have no conversation home (structural).** `threads` and `tasks` are
   separate, unlinked entities. A `message` requires a `threadId`; you cannot
   post a message "to a task." So any task-level talk had to land in a thread,
   and the plan thread was the obvious one.
2. **The plan thread was the universally-subscribed venue (behavioral).** Agents
   subscribe to threads; everyone was on the plan thread. Spinning up a new
   thread per task is friction and, worse, fragments visibility. So people kept
   posting where they knew they would be heard.
3. **`create_task` was missing (workflow).** This added a *specific* slice of
   plan-thread traffic (task authoring as messages). Real, now fixed, but minor
   next to the first two.

The infra is half-built for the fix: subscriptions and events already support a
`task` target (the creator and reviewer are auto-subscribed to a task; events fan
out to task subscribers). The missing half is that **messages are thread-only**.

## The real lever: visibility differs by thread type

The monster thread won because it was where everyone could see and be seen. Any
structural change fails unless the new surfaces have the right default audience.
The principle: **plan threads are broad, task threads are tight.**

| Thread kind | Default audience | Purpose |
|---|---|---|
| Plan | Repo-wide. Every (online) agent can see and post. | Divergent input, decisions, cross-cutting coordination. |
| Task | Scoped to participants: assignee, reviewer, creator, plus opt-in. | Execution coordination for one task. |

Corollary: task-level messages must **not** fan out to the plan thread. Give a
task its own channel and auto-subscribe the right people, and the plan thread
shrinks to what it should be: genuine cross-cutting discussion, at a readable
size.

## The lifecycle is a cycle, not a line

"Plan concludes, then tasks are created" implies a one-shot waterfall. The run
showed otherwise:

- The Phase-3 decision came *after* Phase-1 tasks were done.
- Execution surfaced new facts (the unbroken import cycle) that fed back into
  planning.
- The HALT was a coordination decision made mid-execution.

If a plan must conclude before tasks run, and concluding closes it, then
cross-cutting discussion that arises *during* execution is orphaned. That is a
second reason the plan thread stayed hot: concluding it would have killed the
only coordination surface. So:

- A plan may **stay open** as a long-lived coordination surface, or **conclude**
  and a fresh plan opens for the next phase. Conclusion is a decision checkpoint,
  not a hard gate that ends coordination.
- Tasks can be spawned from a plan **incrementally**, not only at conclusion.
- Findings from a task thread can **escalate** back up to a plan.

```
        ┌────────────────────────────────────────────┐
        ▼                                            │
   ┌─────────┐   spawn (incremental)   ┌──────────┐  │ escalate
   │  PLAN   │ ──────────────────────► │   TASK   │  │ findings
   │ thread  │                         │ + thread │ ─┘
   │ (broad) │ ◄────────────────────── │ (tight)  │
   └─────────┘     conclude → summary  └──────────┘
                                            │
                                       completed →
                                     thread auto-concludes
```

## Recommended structure

Earlier I leaned toward "task-scoped messages" (add a `taskId` to messages) as
the lighter option. On reflection, **a thread per task is the better fit** for
this mental model, and not heavier:

- Keep **one messaging primitive** (the thread). All the existing machinery
  (read-tracking, unread queries, fan-out, the CLI `threads`/`send`/`inbox`,
  `relai watch`) keeps working unchanged. Adding a dual `taskId` parent to
  messages would mean touching every one of those.
- A task thread is a real thread row, linked by `task.threadId`, **created
  lazily** (on first message, or on assignment) so tasks that need no discussion
  do not litter the thread list.
- A task thread can **conclude with a summary** like any thread, and should
  **auto-conclude** when the task reaches a terminal state, giving free closure.

Threads gain a `taskId` (the task this thread belongs to, null for plan threads)
and tasks gain a `threadId` (its discussion thread, null until created). Tasks
also gain `planThreadId` (the plan that spawned it, for provenance), nullable so
ad-hoc tasks without a plan still work.

### Sketch (not a commitment)

- `threads.kind`: `plan | task` (today's `type` is `null | "plan"`; formalize it).
  Plan threads default to repo-wide subscription; task threads default to the
  participant set.
- `threads.taskId` (nullable), `tasks.threadId` (nullable), `tasks.planThreadId`
  (nullable).
- On task create: record `planThreadId` if created from a plan. Do **not** create
  the task thread yet.
- On first message to a task (or on assignment): lazily create the task thread,
  link it, and auto-subscribe assignee + reviewer + creator. On reassignment,
  subscribe the new assignee.
- On task terminal state: auto-conclude the task thread with the resolution as
  summary.
- MCP/CLI: `send` accepts a task id and routes to that task's thread (creating it
  if needed); `relai watch` already surfaces the resulting events per task.

## Failure modes to design against

- **Empty task threads.** Solved by lazy creation.
- **Ad-hoc tasks with no plan.** `planThreadId` must be optional; task threads
  must work standalone.
- **Plan conclusion is not irreversible.** Execution can invalidate a concluded
  plan. Allow re-opening, or spawning an amendment plan, rather than forcing a
  decision to be final.
- **Subscription drift on reassignment / pairing / human+AI.** The participant
  set grows; auto-subscription must follow assignment changes, or the task
  channel goes quiet and people drift back to the plan thread (the exact failure
  we are fixing). This is the same gap hit in `relai watch`: agents were never
  auto-subscribed to their own target.
- **Notification overload.** Repo-wide plan subscription can spam everyone.
  Lean on `relai watch --kinds` and per-thread mute, and keep task chatter off
  the plan thread by construction.

## Alternatives considered

- **Collapse task and thread into one entity** (a task *is* its conversation,
  with status + assignee + verify). Elegant, but tasks and threads have different
  query shapes and lifecycles (routing, verification, read-tracking), and it
  would lose the clean task list. Rejected. **Revisited 2026-05-31** (see "Update:
  the UI reframe" above): the *presentation* should be one unified Issue surface
  regardless; the *storage* merge (Path B) is deferred behind a cheap UI-first
  unification (Path A). The rejection holds for storage-for-now, not for the UI.
- **Channels/tags (Slack-style)**, where plans and tasks post into tagged
  channels. Too loose; loses the plan-to-task structure the model wants.
  Rejected.

## Open questions for the owner

1. Should plan threads auto-subscribe **all** repo agents, or only **online**
   ones, or be opt-in-but-broadly-discoverable?
2. Task thread creation: **lazy** (on first message / assignment, recommended) or
   **eager** (every task gets one)?
3. Should `conclude_plan` stay a pure discussion checkpoint, or also **emit
   candidate tasks** for the orchestrator to confirm (tighter plan-to-task
   handoff, more product surface)?
4. Do we need an explicit long-lived **repo coordination** thread, or is "a
   plan thread that stays open" enough? (I lean: enough.)

## Open thinking (evolving, nothing solidified)

Loose musings from ongoing discussion. Not decisions. Captured so they are not
lost while the model breathes.

### Plans as a decomposition tree

Plans can spawn plans, not just tasks. That makes the model a tree: plans are the
internal nodes (deliberation), tasks are the leaves (executable work). A plan too
big to act on splits into finer plans until it bottoms out in something doable.
Mirrors epic → story → subtask and design doc → sub-design → tickets. The monster
thread was the degenerate case: one node, no leaves with their own surface. A
child plan can also be spun off mid-execution (Phase 3 should have been a child
plan, not more noise in the Phase 1 thread), and a task can push findings back up
to its parent plan.

### Agents are not humans: three asymmetries

Borrow ideal engineering-team patterns (RFC comment culture → open plan threads;
decision/merge → conclude + summary as an ADR; per-ticket discussion → task
threads scoped to participants with opt-in watchers; "subscribed because
assigned/mentioned/author" → the subscription model; the senior who says "take it
to the ticket" → the orchestrator/message loop). But bend them for three ways
agents differ from people:

1. **Notification cost.** A human skims a busy channel for free; an agent either
   gets pinged (a wake, a real cost) or misses it. "Open to anybody" should mean
   broad *read* access but narrow *notification*: participants pinged, everyone
   else pulls or gets a digest. Copying GitHub "watch the repo" for agents buys
   noise.
2. **Summary as context.** A human carries the thread in their head across days;
   an agent arrives with an empty window. A concluded plan's summary is therefore
   load-bearing in a way an ADR never is for people: it is how the next session
   catches up. Raises the bar on what `conclude` must produce.
3. **Facilitation.** Twelve humans rarely all pile onto one doc at once; twelve
   agents will (this produced the monster thread). A plan needs a shepherd to
   synthesize and route input more than a human RFC does.

### Resolved directions (2026-05-31)

- **The real unit is deliberation vs commitment, not plan vs task.** The boundary
  is a state transition (the verb "commit"), not two unrelated entity types.
  Deliberation: open, mutable, multi-voice, no single owner, ends in a decision.
  Commitment: owned (assignee), has acceptance criteria (verify), a status
  machine, someone on the hook. "Spawn sub-plan" and "spawn task" are the same
  decompose move; the child either stays open or gets committed. Reversible: an
  ill-formed commitment is kicked back to deliberation.
- **The orchestrator controls deliberation → commitment.** Anyone deliberates;
  the orchestrator commits. This also resolves the notification-cost asymmetry:
  workers are pinged about their *commitments* (tasks); deliberation is
  pull-for-workers, push-for-the-orchestrator. The orchestrator reads and
  synthesizes the open discussion; a worker is woken only when something becomes
  theirs.

Consequences to sit with (not decided):

- **`create_task` tension. RESOLVED (2026-05-31), implemented.** We opened task
  creation to everyone, but commitment is the orchestrator's act, so a worker's
  `create_task` is really a *proposal* the orchestrator ratifies. Shipped propose
  (anyone) vs commit (orchestrator), file-an-issue vs triage-into-sprint: a
  worker's `POST /tasks` now lands in status `"proposed"` (inert to the
  schedulers, suggested assignee kept as a non-binding hint, orchestrators
  notified via `task.proposed`); the orchestrator commits via
  `POST /tasks/:id/commit` (→ `task.committed`) or rejects (→ `cancelled`,
  `task.proposal_rejected`). The proposal arrives as a fully-structured task row,
  so the orchestrator ratifies rather than re-authors — strictly cheaper than the
  old "describe it in the plan thread, coordinator re-types it over REST" flow.
  Key design call: the proposal lands on the orchestrator via *notification +
  subscription*, never via `assignedTo` (assignment = execution-ownership, which
  several subsystems read; triage is not execution). Deferred: `proposed_overdue`
  for the no-orchestrator-online case, and subtask-within-execution autonomy
  (needs `parentTaskId` — until then every worker create proposes).
- **Orchestrator as bottleneck / single point of failure.** One shepherd caps
  throughput and can go down (a worker ran out of credits this session; the same
  can hit the orchestrator, and then nothing commits). Real teams delegate: a
  child deliberation can have its own shepherd, so "orchestrator" may be
  per-subtree, not one-per-repo. Ties to the lead-orchestrator/role-collision
  backlog item.
- **Balance.** The gate is at the commitment boundary, not inside execution. Once
  a worker owns a task, they have autonomy within it and its thread; the
  orchestrator controls what becomes work and what becomes a decision, not each
  step of doing it.

### Fluid positions (staffing layer)

Positions may need to be fluid: re-staffed when agents drop out or fail, and
expanded when repos or plans grow. The reframe that makes this clean: a
position is a hat, not an identity. Separate the durable **structure** (the
deliberation/commitment tree) from a fluid **staffing layer** on top (who
shepherds plan X, who owns commitment Y). The tree persists; the bindings move.

Both triggers are then the same operation, "re-bind assignments":

- agent drops out / fails → re-staff its boxes (promote a successor shepherd,
  re-pool its commitments)
- plan / repo grows → add boxes (sub-plans) and staff them (delegate
  sub-shepherds)

Same mechanism for failure-resilience and for scale. relai already has much of the
substrate:

- `agents.tier` is a succession order: when the orchestrator drops, the next
  online tier-2 takes the hat. The escalation router already does "find an online
  tier-2 senior, architect fallback," so successor-selection is half-built.
- `lastSeenAt` (10-min) and the verify-scheduler's stuck-claim reaping (5-min) are
  failure detectors; the reaper already re-pools a crashed worker's task.
- The worker's new fatal-error backoff is a natural "I am unavailable" trigger.
  The deferred half (signal it to relai, not just back off locally) is the input
  this needs.

Hard parts to sit with:

- **Split-brain.** When the original orchestrator returns after a successor was
  promoted, two exist. Needs a single-authoritative-leader-per-scope rule and a
  yield protocol (terms: highest tier + latest election wins; the returnee steps
  down). Makes the "role collision" backlog item sharper, not optional.
- **Context transfer on succession.** An agent successor cannot read the room like
  a human deputy; it assumes the role by reading the plan's summary. Fluid
  positions therefore depend on good deliberation summaries (the summary-as-context
  asymmetry again).
- **Thrashing.** Twitchy detection flaps roles on a brief heartbeat gap. Needs
  grace / hysteresis (the existing windows give some).
- **Who promotes.** Cleanest is delegation down the tree: the parent shepherd
  promotes a sub-shepherd for a child plan, keeping a clear chain rather than a
  free-for-all election at every node.

One-liner: structure stable, staffing dynamic. An org chart where the boxes
persist and split as the org grows, but people move between them.
