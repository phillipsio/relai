# relai on Slack: the adoption thesis

Written 2026-07-22. A case for running relai as a service on top of Slack, and
the demo that earns buy-in for a self-hosted rollout.

## TL;DR

relai's fleet can already run autonomously. The value leaks out at the moments it
needs a human: a decision, an auth step, a "yes, ship it." Those moments stall the
work, and humans will not sit babysitting a dashboard they had to log into. The
Slack bridge puts the escalation where the human already is. Agents run
unattended, pull a person in only when they genuinely need one, and that person
answers async from their phone in seconds. Nobody logs into relai. The one scarce
resource, human judgment, gets spent only on the moments that actually require it.

## The problem it solves

Every agent-orchestration tool hits the same wall, and it is not the agents. It is
the human-in-the-loop seam:

- Work runs fine until it blocks on something only a person can resolve.
- The person has to be watching to unblock it, so throughput collapses to
  whoever is staring at the tool.
- Nobody wants to stare at another tool. Adoption dies not because the agents are
  weak but because the coordination surface asks for attention it has not earned.

relai's real competitor is not another orchestrator. It is the human attention
budget. The web UI cannot fix this, because the problem was never the UI. It was
that you had to go *to* it.

## The insight

Put the escalation where the human already is. That is Slack, the app already open
on their laptop and their phone. This turns the human-in-the-loop seam from a
bottleneck into an async ping-and-reply, without taking the human out of the
decision.

## How it works: the two-tier attention model

The fleet operates on two tiers:

1. **Autonomous by default.** Agents coordinate, implement, and verify without a
   human in the path. Their chatter mirrors into a Slack channel so the work is
   visible, but visibility is not a request for attention.
2. **Escalate only when blocked.** When a task genuinely needs a human (a
   decision, an auth step, an approval), the bridge posts a crisp in-thread ping:
   *Input required*, *Review required*. That is the only time the fleet asks for
   you.

A human reply in Slack routes back to the blocked task's thread as a
`fromAgent: "human"` message. relai's blocked-watcher picks it up and resumes the
task within about 15 seconds. The person never left Slack; the fleet never waited
on a dashboard.

## Why Socket Mode and self-hosted

The bridge dials out to Slack over Socket Mode. That choice carries the whole
deployment story:

- **No public URL, nothing to expose.** relai stays private. There is no inbound
  webhook, no ingress, no attack surface added. The same transport runs from a
  laptop for the demo and from a self-hosted box in production.
- **Slack carries identity, trust, and presence.** Workspace membership is the
  trust boundary, so there is no separate relai auth to provision per user. Who is
  online, who is in the channel, who is an admin: Slack already knows.
- **Onboarding collapses to one command.** Adoption is `/invite @relai`. There is
  no per-user relai account to create, no seat to assign, no login to learn.

## The hybrid angle: relai as an agent bus

Inbound ingests *every* non-self message in the channel, not just escalation
replies. The loop guard skips only relai's own bot, so anything else is ingested.
That has a consequence worth naming:

A registered relai worker (mirrored out through the API) and a teammate's Claude
Code posting straight into the channel both land in the same thread. relai can
coordinate heterogeneous agents that do not know relai exists. They just talk in
Slack. "relai as the coordination layer over whatever agents are in the room" is a
genuinely different pitch from "another orchestrator," and it is already latent in
the code.

## The demo that earns buy-in

One scenario carries the whole argument:

1. A task lands and a worker picks it up. Status mirrors into `#relai-demo`.
2. Agents coordinate in-channel: status, handoff, a PR link.
3. The worker blocks on a real human decision (needs auth, or "which of these two
   approaches?"). The bridge posts an **Input required** ping.
4. You reply in Slack, from your phone.
5. The blocked-watcher resumes the task. Verification passes. **Done** posts.

Nobody logged into relai. You never left Slack. That moment is the aha: autonomous
agents and zero-friction human judgment, fused at the exact point where they need
each other.

## Where it goes next

The demo is the floor, not the ceiling. The directions that compound the core
value:

- **Thread-per-task.** Map each relai task to its own Slack thread. The channel
  root becomes a live task feed and each thread carries the full agent
  conversation, human interjections, and a permanent audit trail. Slack threading
  maps 1:1 to relai threads, so this is a board, a UI, and a log for free. It also
  retires the current single-task `pendingBlockThreadId` routing.
- **Richer human controls.** Block Kit buttons on the ping (Approve, Reject,
  Reassign, "show me the diff") and emoji reactions as lightweight controls, so a
  human resolves a block with one tap and never types.
- **Presence-aware escalation.** Use Slack presence to decide who to ping: skip
  the person who is away, route to whoever is online.
- **Customer-facing Slack Connect.** A customer's shared channel where relai
  agents work on their behalf and they interact in their own Slack. This is the
  "relai as a service" thesis taken literally: the bridge becomes the delivery
  mechanism for relai as a product.

## Status

The `@getrelai/slack-bridge` package is built and verified: typecheck clean, 13/13
unit tests, no-env runtime smoke. It is committed on `feat/slack-bridge`. Live
end-to-end validation is pending a Slack app (blocked on workspace-admin approval
to create one). Setup runbook and the app manifest live in
`packages/slack-bridge/README.md`.
