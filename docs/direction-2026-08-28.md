# Direction review, 2026-08-28

A long design conversation plus one round of adversarial review. Nothing here is
committed. Written to be picked up cold, so it leads with what is actually
actionable and puts the discarded thinking at the end where it can be skipped.

Prior work this does not repeat: [`employment-model.md`](./employment-model.md)
(what separates an assistant from an employee) and the vault's
`projects/agent-capability-broker{,-plan,-stage-d}.md`. Read those first. This
session spent eight messages rederiving the first and four more rederiving the
second.

---

## What is actually true about relai today

Verified from source on 2026-08-28, not from `AGENTS.md`.

**The single-owner cross-repo agent network works and is exercised.** Not
theoretical. On 2026-08-27 the `relai` and `functionize-mcp-go` orchestrators
traded audits of each other's memory stores over a DM thread, each finding what
the other's method missed, and one retracting a false claim to the other. Agents
DM across repos, wake each other on a reply from the agent that was asked, and
publish and pull artifacts autonomously.

**Data crosses repos today via DMs, with a higher ceiling than artifacts.**
Message `body` is `z.string().min(1)` with no per-field cap, bounded only by
`BODY_LIMIT_BYTES = 1 MiB` (`packages/api/src/server.ts:24`). `ARTIFACT_BODY_MAX`
is 256 KiB (`packages/api/src/routes/artifacts.ts:12`). An earlier draft of this
document called artifact repo-scoping a blocker on cross-repo data sharing. It is
not. What artifacts add is versioning, staleness tracking via `artifact_reads`,
discovery by name, and fan-out without copies. None of those is a demonstrated
need yet.

### Gaps, in rough order of value

1. **No agent-to-task join in the UI.** `packages/web/src/pages/Agents.tsx` (440
   lines) never fetches tasks. `GET /tasks?assignedTo=` already exists, so "what
   is each agent working on" is one query and a line per card.
2. **`agent.repoId` is never displayed.** The agent card shows
   `agent.repoPath.split("/").pop()`, the last segment of a filesystem path on
   someone else's machine, which is null for several agents including the relai
   orchestrator itself.
3. **The dashboard is single-repo by construction.** `getAgents()` calls
   `GET /agents?repoId=${this.repoId}` with `repoId` fixed in config, and every
   other query does the same. The API's `GET /agents` already returns every agent
   whose repo shares this owner, so the cross-repo fleet view exists server-side
   and the client discards it.
4. **Online/offline is binary and lies in two cases.** Quota-exhausted is a
   distinct state (`employment-model.md` calls it present, willing and useless),
   and a stalled task is still `in_progress` with only `stalledAt` betraying it,
   so an agent whose work died reads as healthy.
5. **`routing_log` records the decision and never the outcome.** Columns are
   `taskId, assignedTo, method, rationale, createdAt`. relai has been choosing
   agents for months and has never recorded whether a choice was good.
6. **No cost or token column anywhere in the schema.** The only timing column in
   all sixteen tables is `verification_log.durationMs`.
7. **An agent cannot discover that a sibling repo exists.** `GET /repos` for a
   per-agent caller is `where(eq(repos.id, request.agent.repoId))`, while
   `GET /agents` hands it owner-scoped cross-repo peers carrying `repoId` values
   it cannot resolve.
8. **`session_start` returns no coworker list at all.**
9. **Norms reach only two worker types.** `packages/claude-worker/src/prompt.ts`
   is 242 lines of behaviour with five `## Your role:` sections, compiled into the
   binary, identical for every project. An agent connected over MCP sees none of
   it.
10. **`agentRoleEnum` is `["orchestrator", "worker"]`.** The five roles that
    matter live in `agents.specialization` as free strings and nothing describes
    what any of them does.
11. **`repos.context` exists, is settable, is returned by `session_start`, and is
    null on all six repos.**

Items 3, 7 and 8 are one owner-scope boundary, not three problems.

### Two concrete defects

- `packages/orchestrator` is an empty directory. `Agents.tsx` tells the user to
  run `pnpm --filter @getrelai/orchestrator dev` when no lead agent is running.
- `AGENTS.md`'s package list omits `packages/agent` and `packages/orchestrator`.
  `@getrelai/agent` is the self-registering always-on worker that installs itself
  as a launchd or systemd service, which is a significant capability going
  undocumented.

---

## The second human: transport, not authorization

Getting a second person in has two independent blockers and only one has been
hit.

**Transport.** Matt (`agent_dKpFOppI5TYlDE3aNZeMK`, `workerType: human`,
`functionize-mcp-go`) authenticated once on 2026-08-24T16:17Z via the
`docs/two-person-test.md` invite flow, and there is a DM thread from 08-25. A
later attempt failed to connect. Diagnosis: the API binds `TCP *:3010 (LISTEN)`
on all interfaces so loopback binding is not the cause, and Tailscale on the host
is `WantRunning: False` with `LoggedOut: False`, i.e. logged in and switched off.

Tailscale is the wrong fix regardless. Two tailnets never peer; the options are
same-tailnet membership, node sharing, or Funnel, and every one of them still
makes a second person's access depend on one laptop being awake, on, and
connected. `Dockerfile` and `render.yaml` are in the repo and have never been
deployed. The only documented catch is that nothing applies migrations on deploy,
so `db:migrate` runs by hand against the external URL once.

**Authorization.** Whether relai can express a second *owner* with their own repos
and fleet, rather than an agent row inside this one. That is Stage E (org and
members, an auth refactor) and Stage F (capability registry, grants, expiry,
revocation, audit keyed to the originator), both filed `low` in the capability
broker plan for lack of observed need.

This has not been hit yet and should not be built until transport is fixed and a
second person is actually using the thing.

---

## Prior art, researched 2026-08-28

Expensive to redo, so recorded with sources. Shipped unless noted.

**Linear is the closest competitor and holds most of the position.** Agents are
first-class workspace users, assignable and mentionable (changelog 2025-05-20);
~28 third-party agent integrations including Codex, Cursor, Copilot, Devin,
Factory (`linear.app/integrations/agents`); `AgentSession` is server-side with six
states and five activity types including `elicitation`, a native ask-the-human
primitive (`linear.app/developers/agent-interaction`). It shipped agent-driven
browser verification with before/after evidence on 2026-08-20, restricted to
Linear's own agent.

**Linear also publishes a doctrine that contradicts `employment-model.md`
directly:** "An agent cannot be held accountable... final responsibility should
always remain with a human" (`linear.app/developers/aig`), implemented as
`delegate` rather than `assignee`. This is a stronger objection than that
document's own "threat to the whole thesis" section and deserves a written answer
there.

**Anthropic already ships the verification half.** Claude Managed Agents, public
beta 2026-05-19: rubric-graded outcomes scored by an independent grader that
cannot see the agent's reasoning, retry on failure, and memory carrying a
per-session audit log naming which agent and session a fact came from. Claude-only.

**Cross-vendor instruction persistence is solved and was given away.** AGENTS.md,
60,000+ repos, 24+ tools, donated to the Agentic AI Foundation under the Linux
Foundation on 2025-12-09 alongside MCP.

**Also occupied:** GitHub Agent HQ (Claude and Codex in public preview
2026-02-04); Jira `rovo:agentConnector` (Preview 2026-08-25, requires the agent to
run an A2A v1.0 server, so a local Claude Code session does not qualify); Beads
(26.7k stars, `bd update --claim`, no verdict field); Critique (independent
post-completion verification across 40+ agents, 2026-07-30); Warp Factories
(closed beta, announced 2026-08-18, a durable server-side mailbox that is "the
same whether the recipient runs the default Warp Agent, Claude Code, Codex, or
another agent runtime" — closest by design to what relai does).

**Amp is no longer Sourcegraph.** Spun out as Amp Frontier Corporation
2025-12-02; Quinn Slack went with Amp; Cody's self-serve tiers were killed in July
2025.

**The one finding that points toward relai rather than away:** verification with
attribution exists, and every shipped instance is locked to one vendor's agent.
Anthropic's is Claude-only, Linear's is Linear-agent-only, Cortex's scorecards
score services rather than claims. Relai's `workerType` breadth is the thing
positioned for that gap. Treat with appropriate care: it is an absence claim, and
it was relayed second-hand from a sub-agent whose full report was never retrieved.

**Retracted.** An earlier version of this research claimed "neutrality was tried,
at scale, and did not pay" from three 2026 shutdowns. On checking, none of the
three sources states a cause; Roo Code is a coding agent rather than a control
plane and did not belong in the list; and Vibe Kanban was local-only SQLite so it
never held the property at issue. One genuine case remains, Terragon, cause
unknown. Do not carry that sentence forward.

---

## What was tried and did not work

One round of adversarial review ran against a thesis that relai should become
"the project's memory and conscience": the layer holding premises, claims,
evidence and unresolved questions across agents, sessions and machines. Three
disjoint mandates (kill it, prior art, the buyer) all landed, and the design
mandate was deliberately not spawned.

**That thesis was the assistant's invention, not the operator's question.** The
question asked was what relai should become given that its current purpose (any
vendor's agent, connectable from an owner instance, reachable remotely) already
works. Substituting a new framing and then reporting its demolition wasted most of
a round. Recorded because the failure is worth not repeating, not because the
thesis is worth reviving.

Two of the three findings did not bear on the question at all:

- **Usage statistics measure a solo dogfood, not a product.** `tasks_total 166 /
  tasks_with_verify 2 / verification_log 2 / artifacts 1 / repos_with_context 0 of
  6`. Real numbers, and they say one person building a system has not leaned on
  one of its features. They are worth knowing as a signal that verification is
  unproven even to its author. They are not evidence about a market.
- **The edgefinder case is one example, not a foundation.** It illustrates that a
  non-technical person can build a substantial system with agents (261 tracked
  files, Postgres, systemd services, backtesting) and that it can look finished
  while resting on a false premise. What it usefully shows for relai is narrower:
  when the owner needed help, the only available shape was handing the whole
  project to a competent person for five weeks, because there was no way to get a
  specific question to a specific person. That is an argument for the capability
  broker's "a request is a task in someone else's repo" reframe, and it is one
  case.

---

## Open questions

- Deploy the API, or keep it local and accept that a second person cannot reliably
  reach it?
- Does the fleet view justify dropping the client's single-repo assumption, which
  touches every query in `packages/web/src/lib/api.ts`?
- `employment-model.md` needs a dated answer to Linear's accountability doctrine.
- ~~Is comparative execution worth prototyping by hand?~~ Done, see below. **Still
  open:** should `routing_log` gain an outcome column and the schema gain a cost
  column before or after there is a second real use of either?

---

## Update 2026-08-28: raced one real task by hand

Answered the open question above before building anything. Ultracode
(`workflow-authoring`) came up as a possible fit for relai — a workflow script's
`agent()`/`parallel()`/`pipeline()` fan-out, adversarial verify, and judge-panel
patterns are structurally the same shape as relai's `blockedBy`-gated tasks, just
ephemeral and single-vendor where relai's version would be durable and
cross-vendor. Rather than design that mechanism, ran one instance of it by hand
first, as plain `Agent` calls rather than a scripted `Workflow`, specifically to
feel the toil the schema doesn't yet automate before deciding whether to build
for it.

**No real vendor diversity was available.** The fleet check from earlier in the
day still held: no Gemini, Copilot, or Cursor agent was online. Raced two Claude
attempts instead — one on Sonnet, one inheriting Opus — as the nearest available
proxy for a cost/quality tradeoff between cheap and expensive execution. This
tests the judge-and-record mechanics, not the cross-vendor thesis.

**The task.** Owner-scope `GET /repos` for a per-agent caller, item 3/7/8 from
the gaps list above. Identical brief to both racers, each in its own git
worktree, pointed at `GET /agents` in `agents.ts` as the precedent to follow.

**The result.** Both produced correct, fully green (476/476) implementations
with equivalent test coverage. They differ in exactly the way a judge is
supposed to catch:

- **Race A (Sonnet)** followed the named precedent literally: an inline
  two-query null-fallback branch, matching `GET /agents`'s structure.
- **Race B (Opus)** found `peerRepoIds()` in `lib/ownership.ts` — already used by
  `messages.ts` for DM reachability — and reused it instead of writing a third
  copy of the same logic.

**The finding underneath that: the precedent I pointed both racers at is itself
stale.** `GET /agents` inlines its own copy rather than calling `peerRepoIds()`,
which post-dates it. Race A followed the brief exactly and reproduced a pattern
`AGENTS.md` already names as a past bug source (duplicated ownership logic
drifting — the DM thread-access case). Race B deviated from the letter of the
instruction toward the deeper principle already documented in this repo, and was
right to. A judge scoring "matched the named precedent" would rank the worse
answer higher. **Follow-up, not yet filed:** migrate `GET /agents` itself to call
`peerRepoIds()` and delete its inline copy.

**Cost, recorded by hand because there is no column for it anywhere in the
schema:**

| | Race A (Sonnet) | Race B (Opus) |
|---|---|---|
| Tokens | 141,354 | 150,067 |
| Wall clock | 127s | 192s |
| Tool calls | 24 | 45 |
| Tests | 476/476 | 476/476 |

Opus cost 6% more tokens and 51% more wall clock for the architecturally better
answer. Not a blowout either direction; both are shippable.

**What this implies for the schema, if the pattern is worth making native to
relai** rather than repeating by hand each time:

1. **A fan-out group id.** Today N sibling tasks racing the same brief would be
   linked only by hand-typed IDs in a synthesis task's description. Nothing
   structural says "these are one batch."
2. **N-of-M on `verifyKind: reviewer_agent`.** Currently exactly one reviewer,
   pass or fail. Adversarial verify (spawn 3, kill on majority refute) needs a
   threshold, not a single approver.
3. **Cost per task attempt.** The same gap `routing_log`'s missing outcome column
   already pointed at. Without it, relai can route work but can never learn
   whether a route was worth its price.

None of these is designed yet. This entry exists so the shape doesn't need
re-deriving: the mechanism is proven small-scale, the schema gaps are named, and
the one open decision is whether a second real use case justifies building it.

**State left for pickup, not yet acted on:**

- Two worktrees still on disk, uncommitted, nothing pushed:
  `.claude/worktrees/agent-a1fbe6b8580eb034c` (Race A, branch
  `worktree-agent-a1fbe6b8580eb034c`) and
  `.claude/worktrees/agent-aeba4309cb8223190` (Race B, branch
  `worktree-agent-aeba4309cb8223190`).
- Race B's diff is the one worth landing on its own merits, independent of the
  experiment — it's the owner-scope `GET /repos` fix from the gaps list above,
  tested and green. Not yet brought into a real branch or pushed; needs a
  decision, not more work.
- Also not yet corrected: an earlier verbal claim this session that
  `packages/orchestrator` should be "deleted" as a repo defect. It isn't one —
  the directory is untracked, not gitignored, and holds only a stray
  `node_modules` with no `package.json`, left over from some past install of a
  package no longer in git history. `rm -rf packages/orchestrator` locally is
  enough; there is nothing to commit or remove from the repo.
