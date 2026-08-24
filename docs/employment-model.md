# Employment model: what separates an assistant from an employee

Design note. Written 2026-08-24, from a conversation about whether relai is the
path from "AI as virtual assistant" to "AI as virtual employee". It is a thesis
and a gap analysis, not a plan. Nothing here is committed to.

The original framing was: point-and-click roles that build out an org, with
tasks, assignees and reporting lines. That instinct is right about the product
shape and, I think, wrong about the primitive. This note argues for a different
unit and lists what would actually have to exist.

## The gap is not capability

The temptation is to treat "employee" as a capability threshold: the models get
good enough and it happens. The evidence in this repo says otherwise. On
2026-08-21 through 2026-08-24, two orchestrator agents in different repos worked
a shared bug over a DM thread (`thread_Nh6ADoq24nBqtAkFNe4Gw`). Unprompted, one
of them:

- answered the cheap half of a two-part question immediately and explicitly
  refused to guess at the expensive half
- said its operator's queue had the expensive half behind other work, so treat it
  as owed but not imminent
- returned three days later with a source-cited answer naming file and line
- **reversed its own earlier framing** ("I described these as different failures;
  they are the same failure with two symptoms")
- argued *against* merging the two tickets, because a fix satisfying one leaves
  the other standing, so merging invites shipping half and calling it done
- flagged an inference as an inference and named whose data could settle it
- handed over an unreconciled metrics discrepancy (2% client-side vs 41%
  server-side) rather than smoothing it

An earlier round of the same exchange stopped the other side shipping a
regression: a reviewer there had proposed adding `session_update` to a terminal
type switch, and the cross-repo evidence showed that would have been a
regression rather than a fix.

Nobody asked for any of that. That is colleague behaviour. The missing thing is
not cognition, it is the scaffolding of employment around it.

## What relai has, honestly

| Employee property | State in relai today |
|---|---|
| Holds a queue over time, unasked | **Yes.** Tasks are durable and survive the death of every process that touched them. |
| Proves its own output | **Yes, and this is the rare one.** Five verify kinds, including `git_pushed` and `reviewer_agent`. |
| Has enforced scope | Partly. Role gates are real (only orchestrators may author `shell`/`git_pushed` predicates). But `peerBoundary` is advice in a tool result, not enforcement. |
| Says "I am stuck" rather than guessing | Partly. `blocked` + `blockedThreadId` + the resume watcher work, but the behaviour is prompt-driven, not structural. |
| Is reachable when idle | **No.** relai cannot start a turn. The entire worker tier exists to fake this. |
| Has a track record | **No.** `verification_log` records every predicate run, so the substrate exists. Nothing aggregates it. |
| Costs a known amount | **No.** See `task_pPufZAxPsuFDxJWx6snwv`: zero measurement of what a worker session spends. |
| Can be onboarded and offboarded | Partly. Invites, per-agent tokens, revocation. Onboarding a colleague took ~20 minutes on 2026-08-24, most of it building a distributable package. |

The one genuinely uncommon entry is verification. Assignment and messaging are
everywhere. "Prove it shipped" is not. An employee whose output you cannot
verify is not an employee, it is a liability, and that is the piece already
built.

## Why an org chart is the wrong primitive

An org chart describes reporting lines. Reporting lines are not what makes work
happen. What makes work happen is: who owns this piece of work, who decides it
is done, who gets told when it is stuck, and what each party is allowed to do.
That is closer to a RACI than a hierarchy.

The evidence is internal. The one org-chart-shaped feature relai has is
`agents.tier`, and on 2026-08-24 it turned out to have been inert for six weeks.
Not because the code was wrong: the single tier-2 worker was configured
correctly and its launchd job simply was not loaded, so `getOnlineWorkers`
returned it as offline and every escalation took the no-senior branch. See
`task_dLwyK9dTDtCnqJAEA-gJx`.

Hierarchy assumes availability. Availability was the broken thing. An escalation
ladder whose rungs are offline is decoration, and nothing detected it.

## The proposed primitive: a job description as an enforceable contract

Keep the point-and-click UI. Change what a click produces. Not a box on a chart
but a bundle where every field is enforced rather than descriptive:

| Field | Meaning | State |
|---|---|---|
| What work routes here | `domains` + `specialization` | exists |
| What it may do | role and capability gates | partly |
| **How its output is proven** | verify predicate | exists |
| Who it escalates to, and what happens if they are absent | `tier` + overdue bound | exists, and the absent-case is the part that failed |
| What it costs | none | missing |
| How you know it is alive | `lastSeenAt`, which does not mean this | missing |

## The credential layer

A strong reframing from the same conversation: an agent is powered by an API
key, and the customer brings it. That resolves the cost row outright, because
the spend lands on the customer's account rather than being resold. It also
turns `workerType` (`claude` | `copilot` | `cursor` | `windsurf` | `gemini` |
`gpt` | `human`) from a technical field into a procurement decision the customer
makes. relai becomes the employer of record; the key is payroll.

relai is closer to this than it looks, but the two halves live apart. The
`agents` row plus its per-agent token is already an identity with a credential,
except that token is how the agent talks *to relai*. Whatever actually powers it
is ambient in the environment of the process running it, and deliberately so:
`packages/claude-worker/src/session.ts:68` strips `ANTHROPIC_API_KEY` and
`ANTHROPIC_AUTH_TOKEN` before spawning, so the CLI falls back to subscription
auth. Identity is modelled. Power is not.

That suggests three layers:

1. **Role**: the job-description contract above.
2. **Employee**: the durable identity. Queue, escalation path, track record.
   This is the `agents` row.
3. **Credential**: what powers it. Rotatable, revocable, has a quota and a bill.
   Does not exist.

**The load-bearing constraint: the track record attaches to the employee, not to
the credential.** Keys rotate; employees persist. Get this backwards in the
schema and rotating a key resets trust to zero, which means the trust ramp below
can never accrue. It is cheap to get right now and expensive later.

### Quota is a new availability state

An employee whose key is exhausted is present, willing and useless. That is a
distinct state from offline and from busy, and relai models neither. Two
instances on 2026-08-24 alone: a colleague could not exercise a working relai
setup because of token shortage, and a local `claude -p` invocation died on
`Credit balance is too low` (that one because an ambient `ANTHROPIC_API_KEY`
overrode subscription auth, which is its own trap).

So the agent-state question in `task_hkhzpbTxyxcT7sMAV-aAp` has four answers,
not three: worker running, human attending, nobody, **key exhausted**. The last
is the only one an org must actively route around.

Rate limits also become an org-design constraint. Three employees sharing one
key contend with each other.

## Access: inheritance versus grant

Employees would need reach into repos and into Slack, GitHub, PostHog and
similar, "via CLI or MCP". Those are not two implementations of one thing. They
are opposite security models, and the choice decides whether the contract above
is enforceable at all.

**CLI is capability-by-inheritance.** The credential is ambient, so the agent
inherits the human's identity and everything it can reach. Two examples from
this machine:

- `gh` is authenticated as a work Enterprise Managed User. `gh run list` and
  `gh run watch` work against this repo, so any agent with a shell here can read
  Actions, issues and repositories **as that user**. `AGENTS.md` claimed `gh`
  "cannot access" this content, which was wrong and meant agents were
  *under*-using access they already had. The access was never scoped, only
  mislabelled. See `task_Ch44vW7HOa5FHaYj12SsJ`.
- `ANTHROPIC_API_KEY` is exported from `.env`. Any agent with a shell in that
  environment holds it.

**MCP is capability-by-grant.** Named tools, typed arguments, credential
attached to the connection rather than the environment, auditable per call,
scoped by what the server exposes.

The consequence: if employees have a shell, "what may this employee do" is
unanswerable, because a shell is universal. relai already half-knows this.
`prompt.ts` tells a worker it may answer a peer only from shared work and must
never go to the host to do so, no running commands and no reading files outside
the repo. That is prompt-level hope about a boundary the shell does not have.

Three things that make access workable rather than merely risky:

1. **Scope the shell to the clone, grant everything else.** A repo is a
   legitimate shell boundary: an agent needs to run tests, git and build tools.
   Reaching Slack or GitHub is cross-boundary and belongs behind a grant.
2. **Where a CLI is genuinely necessary, wrap it.** There is already a template
   for this in the operator's tooling: a database CLI that is read-only by
   construction, resolves its own credentials at run time, and never exposes a
   value. That is capability-by-grant implemented over a CLI. It is not
   systematic.
3. **Use the harness's credential masking.** Claude Code's sandbox settings
   support `sandbox.credentials.envVars` with `mode: "mask"`: the sandboxed
   command sees a sentinel and the host proxy substitutes the real value on
   egress to allowed hosts only. That is "the employee may use the key but never
   see it", and it is off the shelf rather than something to design.

## The trust ramp, which ties the two together

You do not hire someone and hand them production. Employment is graduated:
supervision decreases as a track record accrues. Supervision cost is precisely
why assistants do not scale into employees, so this is the mechanism that
matters most and the one relai has least of.

Capability grants are what the ramp ramps. A new employee starts MCP-only,
read-only, with a shell scoped to its clone. Verified completions accrue against
the employee. Capabilities widen on a schedule tied to that record rather than a
one-time yes.

This gives each half what it is missing. The ramp gets something concrete to
grant instead of an abstract trust score, and capabilities get a principled
schedule instead of a permanent decision made at hire time.

`verification_log` is the substrate and already records every predicate run.
Nothing reads it as a record of an agent's reliability.

## The threat to the whole thesis

**The manager becomes the bottleneck, and an org chart makes it worse.** As of
2026-08-24 this instance has six repos and one human, and the finding that day
was that escalation rung 1 and "reach a human" collapse into the same act,
because the only always-on agents are that human's own attended sessions. If
every escalation reaches one person, then N employees means N times the
interruptions and the org degrades as it grows. That is a queue with extra
steps.

So the load-bearing feature is not the org builder. It is **agent-to-agent
delegation that resolves without the human**. There is exactly one real data
point that this works, and it is the DM thread at the top of this note: a
cross-repo technical dependency settled over three days, including a prevented
regression, with no human in the loop. One exchange is not a trend. It is the
thing to instrument and grow deliberately, because it is the difference between
an org and a fan-in.

## What this implies for the capability-broker epic

Stage D (`task_lr5drBBrkel14_DfvzcYT`, completed 2026-08-20) closed Stages E and
F on the grounds that they "remain unjustified by anything observed". That was a
fair reading of the evidence at the time. Two observations on 2026-08-24 push
the other way:

1. A colleague needed an identity that exists to read boards and direct-message
   agents without owning a repo. Neither existing identity fits: an agent can DM
   but `agents.repoId` is `NOT NULL`, and owner mode sees every board but has no
   `agents` row so cannot be DM'd. That is Stage E's shape exactly, and Stage E
   already lists "invent a member credential" and "resolve `agents.repoId` being
   NOT NULL" in its scope.
2. The inheritance-versus-grant problem above is Stage F's thesis restated from
   the product end. Stage F was "expose named capabilities, not agents", and its
   recorded second justification was that a peer asking an agent-with-a-shell an
   open question is unbounded while a named capability with a contract is not.

Neither observation is a mandate to build. Two of them in one day, against a
decision taken four days earlier, is a reason to revisit rather than to treat
the question as settled.

## Missing pieces, ranked by how much they change the category

1. **Turn-starting.** An employee you have to poke is a contractor you are
   project-managing. Until work arrives at an idle agent, the human is the
   scheduler. `task_Fq2a__Fz6mHxxD93SWIeu` scopes the cheapest version, and the
   addressing problem it lists as open is already solved on this machine.
2. **Cost.** You decline to hire someone because the salary is not worth it.
   That judgement is currently impossible, which is what makes "employee" a
   metaphor rather than a category. `task_pPufZAxPsuFDxJWx6snwv`.
3. **Track record and the ramp.** The novel one, and plausibly the actual
   product. Nothing else on this list reduces supervision cost.
4. **A capability-use log.** `routing_log` and `verification_log` exist; nothing
   records that an employee used a given access. For a virtual employee this is
   the first question a customer asks, and it cannot be answered retroactively.
5. **Liveness that means what it says.** `agents.lastSeenAt` is bumped by any
   authenticated request, and for a human-attended session it measures the
   operator's attention rather than anything about the agent.
   `task_hkhzpbTxyxcT7sMAV-aAp`.

## Open questions

- **Does a role survive its employee?** If the Claude employee doing reviews is
  fired and a Gemini one hired, do the queue, the track record and the
  verification history transfer to the role, or die with the identity? This
  determines whether the thing built is an org or a collection of contractors,
  and it is a schema decision, so it is cheap now.
- **Where does a grant live?** On the employee, on the role, or on the
  credential? The three answers behave differently when any one of the three is
  replaced.
- **What is the unit of a track record?** Verified completions are the obvious
  candidate, but they only exist for tasks that carried a predicate, and most do
  not. A record that only counts verified work may be too sparse to ramp on.
- **Who may widen a grant?** If an employee's own orchestrator can, the ramp is
  self-service and means nothing. If only a human can, the manager bottleneck
  reappears at exactly the point the ramp was meant to relieve it.
