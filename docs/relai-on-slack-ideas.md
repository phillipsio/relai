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
