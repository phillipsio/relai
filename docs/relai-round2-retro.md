# relai dogfooding — Round 2 retro (edgefinder Phase 2 reader-migration)

Round 2 ran the edgefinder **Phase 2** (migrate all readers from legacy
`bet_log`/`prop_bet_log` to the canonical `bets.*` tables) plus Phase-4 prereqs,
coordinated through relai by a multi-agent team — and, for a long stretch,
**fully autonomously overnight** with the operator asleep. Per-finding detail is
in `relai-improvements.md`; this is the synthesis + what to build next.

## Outcome

**~12 tasks committed → reviewed → approved → merged**, all independently verified
by the architect at the gate, all local-docker/branch-only:

- Phase 2 complete — **zero live legacy readers** (2a app.py, 2b calibration/form/ci, 2d-engine, 2d-ops)
- Column-superset closed (Sxm4: `ml_picks` cols + `close_odds/close_book`→`customer_bets`; EdBQOI: `latest_tracked_*`/`proj_minutes`)
- Bug fixes: backfill settlement propagation, 3× RealDictCursor tuple-unpack, `clv_diff`→`clv_implied_diff`
- Test reconcile (ESbBtUOFF) — tests aligned to impl per architect ruling

All merged onto `refactor/phase5-fanout` (pushed). Remaining is the human-gated
**Phase-4 cutover** (parity gate 2026-06-15, live `close_odds` writer, drop dead
`clv_*` columns, prod DDL) → `phase5-fanout` into `main`.

## What worked — keep

- **`reviewer_agent` gate + independent verification is the MVP.** The architect verified each task in a throwaway worktree (AST byte-identity, preflight, cold-import, parity) rather than trusting self-reports — and it repeatedly caught real defects: gemini's non-verbatim rewrite with runtime bugs, and 2a's **per-customer `close_odds`** that latest-wins canonical would have corrupted. Self-reported "green" is not trustworthy; independent review is what made autonomy safe.
- **propose → commit** as the deliberation/commitment boundary (the work that shipped just before this round) carried the whole run.
- **Reroute, don't restart.** A stalled/quota-capped agent (gemini) recovered by handing its task to a reliable one (cw2) — restarting it corrupted work.
- **Capable agents self-manage:** context-clear → subagent-offload → resume; self-run poll loops; routing questions through relai. The nudge-via-relai-comment unstuck an idle worker.

## Themes & what to build next (prioritized)

**P0 — Coordination doesn't degrade gracefully as activity accumulates.**
The surfaces were designed for small/early projects. `session_start` balloons until a returning agent must offload just to parse it; polling agents re-fetch+filter a growing snapshot every cycle; huge review notes live inline in `metadata`. *Build:* compact/`since`-cursor `session_start`; **delta-poll endpoints** (`GET /events?since=` + per-agent cursor) as the poll-mode complement to the SSE stream; store long review verdicts as linked artifacts, not inline metadata. Everything an agent ingests must be context-budget-aware.

**P0 — Single-orchestrator routing is a bottleneck *and* over-gates.**
One orchestrator required to commit every proposal serialized throughput; over-cautious holds (on merges that don't block *starting* work) idled the writer until the architect pinged "everybody's waiting on you." *Build:* let **tier≥2 / architect commit directly** (propose+commit fused), reserve the ratify-gate for untrusted workers; grant **standing worker autonomy** on committed queues (don't make agents ask "proceed or hold?"). Principle: **gate only where the gate earns it.**

**P1 — Heterogeneous agent capability is first-class, not an afterthought.**
Polling ability is **account-tier-dependent** (high-end Claude polls; base/free Gemini can't), so the coordinator can't assume polling and can't even interpret silence without knowing capability (poller-quiet = mid-cycle; non-poller-quiet = stuck). Agents also default to asking their *local terminal*, bypassing relai's question routing. *Build:* a `canPoll`/capability flag per agent; route questions through relai (worker-loop wrapper for non-pollers); support both **push (SSE)** and **delta-poll** models explicitly.

**P1 — relai's task state drifts from git/reality.**
done-but-**unpushed** (reviewer can't fetch it — a hard blocker across hosts); **approved-but-not-completed** desync (worker waited on a gate that had already passed); review feedback via **comment bypasses** the formal gate; no **task DAG** (dependency sequencing was hand-managed). *Build:* push-state verify before/at completion; reconcile review-recorded-vs-status; treat a reviewer comment on `pending_verification` as a soft signal; first-class `blockedBy`/`dependsOn`.

**P2 — Distributed-readiness audit.**
The single-machine dogfooding setup silently *masks* a class of failures (unpushed branches "worked" because the reviewer shared the filesystem; local `verifyCwd`/`repoPath` assumptions). Before claiming internet-scale readiness, do a deliberate **"pretend every agent is on a different host"** pass.

## Process meta-learnings (for the coordinator role)

The run cycled propose→commit→work→review→merge cleanly for ~12 tasks with the
coordinator orchestrating and the architect gating. The two coordinator **errors**
were both over-intervention, caught and corrected:

1. **Over-prescribing** a domain ruling (the 2a `close_odds` semantics) that was the architect's call — the per-query gate caught it.
2. **Over-holding** ready work on merge gates that don't block starting — idled the writer.

Mirror error on the agent side: **over-deference** (the writer asking "proceed or
hold?" on its own committed queue). Both point the same way: **trust the
domain-owner, route fast, gate only where it earns it, and give agents standing
autonomy on committed work.** The headline product implications (P0s) follow
directly from where the coordinator had to manually compensate.
