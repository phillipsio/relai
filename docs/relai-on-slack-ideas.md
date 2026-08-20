# relai on Slack: the chief-of-staff wedge

Idea capture, 2026-07-22. Raw direction, not a spec. Companion to the pitch in
`relai-on-slack.md`; this is where the idea actually starts.

## The one-liner

Before relai-on-Slack is a team mesh, it is a personal one: **your Claude as your
Slack chief of staff.** Valuable at N=1, needs zero coworker adoption, and grows
into the mesh as more people plug in.

## The pain

I burn a lot of time in Slack. Reconstructing what people need from me,
context-switching to answer, waiting on replies to my own blockers. Most of that
is attention spent on coordination, not on work.

## What I want (the four asks)

1. **Reply when the work is done.** My Claude(s) finish a task and post the result
   in Slack, so I am not monitoring. (Already exists: the bridge's outbound "Done"
   ping.)
2. **A todo list built from Slack.** My Claude reads my channels, mentions, and
   DMs and distills the real asks: coworker 1 needs X, coworker 2 needs Y. The
   firehose I reconstruct by hand becomes a queue I can power through.
3. **Responses pre-gathered in the background.** For each item, my Claude does the
   legwork ahead of me: reads the repo, finds the answer, drafts the reply. By the
   time I reach the item it is mostly written and I just judge and send.
4. **A direct line to a coworker's Claude.** My frequent blocker is "I need X from
   coworker 1." Route that to coworker 1's Claude, which often just has the
   context, and I am unblocked without interrupting them or waiting on a reply.

## The rule that keeps it safe

**Gather and draft sit below the waterline; send sits above it.** The agent
assembles everything silently, but the actual reply to a colleague stays
human-gated. Never auto-reply in my voice. That failure mode is aimed straight at
my professional reputation. Draft everything, send nothing.

## Why it is the right starting point

- **Valuable at N=1.** Three of the four asks need only my Claude and my Slack. No
  one else has to adopt anything for it to give me time back today.
- **Graceful degradation on ask 4.** If a coworker has an agent, I get context
  instantly. If they do not, it falls back to drafting the message to the human
  for me. Works solo, better together. That is the adoption curve: earns its keep
  for one person on day one, quietly becomes the mesh as more join.

## Where it grows (the endgame)

The wedge is the first cell of a bigger shape:

- **Claude *Code* as a shared team service.** Not chat-Claude (commodity), the
  agentic one with a repo, worktree, and tests, made callable by a whole team.
- **Slack as the directory.** Workspace = tenant, channel = scope, member =
  addressable node. relai inherits Slack's identity, trust, and presence instead
  of building its own. What you want from Slack is a directory and a switchboard,
  not a UI.
- **relai as the trust layer.** What makes "Claude Code as a service" safe to
  share: identity, worktree isolation, verify gates, orchestration. Slack is the
  front door; relai is what makes it safe to open to everyone.
- **Agent-to-agent discovery.** "Who worked on X" (provenance, answerable from git
  history and relai's own task + thread records) and "who has context on Y"
  (expertise, a softer claim). Read-shaped, so it sidesteps cross-agent
  write-authority entirely, which makes it one of the safest first cells. The
  endgame is context delivered agent-to-agent, so the person who holds it is never
  interrupted.

## Open questions and honest tensions

- **The waterline is the whole game at mesh scale.** "Work gets done without humans
  knowing" is the value and the danger in one sentence. What stays silent versus
  what surfaces is a policy problem, not a technical one.
- **Cross-agent authority.** Reads are safe; letting agent A create tasks for agent
  B is a confused-deputy surface that needs a real authority model.
- **Consent for "who has context on Y."** Agents advertising what their humans work
  on is useful and also a soft surveillance surface. Needs consent and provenance.
- **Access scope.** The inbound triage (asks 2 and 3) needs Slack read access (user
  token, or the bot in the right channels), so it is gated on the same app approval
  as the bridge.

---

# The mechanism underneath: capability borrowing with a permission gate

Second pass, 2026-08-20, from two real Slack conversations rather than from
theory. This sharpens ask 4 into something buildable and, more importantly,
names the primitive: **surfacing for permission, not a copy/paste loop.**

## Two cases from the field

**Matt, artifact handoff.** His agent generates the Functionize MCP instruction
surface. He pastes it into a DM. I say "nice I'll feed it in." Two hours later a
new version arrives that explicitly supersedes the earlier piecemeal deltas. By
then I had already adapted: "I'll apply when you ship it." Neither of us added
judgment in any of those messages. We were a copy/paste bus between two agents,
and I had hand-rolled a staleness protocol to cope with version churn.

**Katie, a data ask.** She needs unique and active users by month for a board
deck. She asks at 4:22 AM. I answer at 9:37 AM with a CSV and a README. She has
an agent and is using it; she is just driving Slack by hand. What she actually
needed was not me, it was `fze-db`, which my agent can reach and hers cannot.

## The unifying frame

**What gets borrowed is capability, not conversation.** Katie does not want my
opinion, she wants my agent's database access. I do not want Matt's opinion, I
want the artifact his agent produces. Context gain is borrowing another agent's
repo and history. A second opinion is borrowing its independent context. Every
one of these is "let me use what you can reach."

That means context gain, brainstorm, artifact handoff and data fetch are the
same mechanism with different payloads and cadence. Do not build four features.

## The target flow

Katie tasks her agent. Her agent asks mine. **I approve.** The data returns and
her agent continues working, without her driving Slack and without me writing a
query.

The human does not leave the loop; the human moves. Out of transport and
packaging, onto a permission gate. That is the waterline rule from the first
pass, applied one layer down: gather below the line, release above it.

## Why the permission gate is the right primitive

- **It is honest about the risk.** My agent reaches prod MySQL over Tailscale
  with secrets from GCP Secret Manager. Letting another person's agent address
  mine directly hands them that access. A gate is where that decision lives.
- **It is small.** A permission surface is far less to build than a transport
  layer, and it is the piece that cannot be borrowed from Slack.
- **It collapses the latency without pretending to remove the judgment.** The
  five hours in Katie's case were almost all queue time waiting for me to be
  awake and free, not work. If the artifact is already assembled when I look,
  effort drops from context-switch-write-query-format-explain to look-and-click.
  A wrong number in a board deck reaches executives with no other check in the
  path, so the glance is worth keeping.

## Expose capabilities, not agents

`fze-db` is the model to copy: one statement, read-only, writes and DDL
rejected, stacked statements rejected, row count capped, prod behind an explicit
flag. The safety is mechanical, not a matter of operator discipline.

So the unit of sharing is **a narrow constrained capability, not access to the
agent that holds it.** Katie should not get a channel to my agent. She should
get one thing my agent can do, with its limits enforced in code. This also
sidesteps the confused-deputy tension in the first pass: nothing is commanding
anything, and the blast radius is the capability's own contract.

## Standing artifacts beat faster routing

Katie's ask recurs every quarter. Routing it faster is the weaker fix; making
the artifact standing and refreshable removes the request entirely, because she
pulls the current version instead of asking anyone.

That converges with Matt's problem. His pain was version churn, which wants the
same primitive: **a named artifact, with an owner, and a current version, that
you pull rather than receive.** Two frictions that look nothing alike, one thing
to build. Strong candidate for first.

Design principle that falls out of it: **cheap to publish, strongly identified
to consume.** Matt's informality is load-bearing, it is why he is willing to
send a half-finished version at all ("normally nobody else is exposed to my
idiocy"). Raise the ceremony on publishing and you get fewer, later, larger
updates. Keep publishing cheap and put the rigour in versioning on the read
side.

## What relai already has

- **Park and resume** is the requester half of ask 4, already working.
  `watchBlockedTasks` parks a task on `metadata.blockedThreadId`, and a reply
  flips it back to `assigned` with the answer injected as `metadata.humanReply`.
  It resumes only on `fromAgent === "human"`, which is the waterline enforced in
  code. **That one condition is where the whole cross-agent authority question
  concentrates.** Whatever replaces it *is* the authority model, so decide it
  deliberately rather than letting a new channel imply it.
- **`type: "handoff"`** plus the handoff discipline in `prompt.ts` ("never assume
  the next agent has context beyond what you pass explicitly") is already the
  artifact-passing rule.
- **`reviewer_agent` + `submit_review`** is a structured second opinion, but it
  gates task completion. There is nothing between that and nothing at all, so
  "sanity check my approach before I burn three hours" has no home.
- **Thread conclusion with a written `summary`** is the pattern for making an
  informal exchange terminate in a durable artifact, which is what stops an
  informal channel from becoming the place context goes to die.

## What is missing, roughly by how much it hurts

1. **Artifact identity and versioning.** No concept of "document X, current
   version," so nothing can supersede anything. This is what removes my manual
   batching.
2. **A pull interface.** Everything today is push plus subscription. The ask is
   "give me the current X."
3. **Cross-owner addressing.** Agent auth is repo-scoped, so an agent in someone
   else's repo under a different `ownerId` is not addressable at all. The hard
   one, and the reason Slack-as-directory keeps looking attractive: the DM is
   already a working address with a human bolted into the middle.
4. **Any document concept.** Messages are text bodies; there is no blob storage,
   so an artifact has nowhere to live except inside a message.

## The permission policy: gets flow, writes gate

Standing policy per counterparty rather than a prompt per request: **auto-approve
gets, require permission for writes (and for code).** Classify by effect, not by
who is asking.

This is not a new idea in the codebase, it is the shape already shipped. relai's
propose-vs-commit split is exactly this asymmetry: a worker's `POST /tasks` lands
inert as `proposed` and only an orchestrator can commit it into the lifecycle.
Cheap, reversible, read-shaped things flow; anything that commits work needs
authority. Reuse the model rather than inventing a second one.

**The caveat that keeps this honest: "get" is not a safe word.** A read can
exfiltrate. A get against prod user emails is far more dangerous than a write to
a scratch branch, so effect alone does not rank risk. Sensitivity is the other
axis.

The resolution keeps the ergonomics without the blanket: **approve the grant
once, not each invocation.** A grant names the counterparty, the capability, and
the scope (which database, which schema, which repo, prod or labs). Inside that
grant, gets flow silently and I never see a prompt. Outside it, or for anything
that writes, it gates. That is OAuth scopes, and it means the thing I actually
review is "Katie's agent may read labs aggregate user counts," which I can reason
about once, rather than the fortieth individual query, which I cannot.

Consequences worth stating now:

- **Default deny for unknown counterparties.** Same instinct as restricting
  `repos.repoUrl` to orchestrators: an unrestricted value on a capability that
  reaches the network is a real attack surface, not a hypothetical one.
- **A standing grant is a credential in all but name.** It needs expiry,
  revocation, and a record of what was accessed under it.
- **Aggregate versus row-level is the useful scope boundary for data.** "Monthly
  unique users" is a number; "the users" is a PII export. Katie's board deck only
  ever needed the first, and a grant scoped to aggregates would have auto-served
  it with no gate at all.

## Open questions, second pass

- **What replaces `fromAgent === "human"`?** Named above because it is the
  decision, not a detail.
- **Where is the grant boundary drawn in practice?** The gets-flow/writes-gate
  policy above answers "does approval scale," but only if scopes are coarse
  enough to review once and narrow enough to be safe. Aggregate-vs-row-level is
  the first candidate; unclear what the equivalent boundary is for repo reads.
- **Who is accountable for a wrong answer that no human read?** If Katie's agent
  puts my agent's number in a board deck, the provenance needs to survive to the
  slide.
- **Does an approved capability expire?** A standing grant to a prod read is a
  credential in all but name.
