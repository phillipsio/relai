# @getrelai/claude-worker

Headless Claude Code worker loop. Polls relai for assigned tasks, runs them through Claude with the relai MCP server attached, and reports back.

## Run

```bash
API_URL=http://localhost:3010 \
API_SECRET=<agent-token> \
AGENT_ID=<agent-id> \
PROJECT_ID=<project-id> \
REPO_PATH=/absolute/path/to/the/working/repo \
pnpm --filter @getrelai/claude-worker dev
```

The worker shells out to the `claude` CLI (override path with `CLAUDE_BIN`); model defaults to `sonnet` (override via `CLAUDE_MODEL`). Authentication is whatever your `claude` CLI is logged in as — no `ANTHROPIC_API_KEY` is read by the worker itself.

`REPO_PATH` is the directory the worker treats as its working tree. The agent's `repoPath` field on the relai record is informational only — the worker uses this env var.

## What the worker needs installed

| Tool | Required? | Why |
|---|---|---|
| `git` | yes | branch creation, commit, push |
| `gh` ([GitHub CLI](https://cli.github.com)) | optional | the writer-specialization prompt prefers `gh pr create --fill` because it captures the PR URL in one step |
| `node` ≥ 20 | yes | the worker process |

The writer prompt **falls back to `git push -u origin <branch>`** when `gh` is unavailable or fails — the worker still finishes the task and hands off to a reviewer, just with a branch URL instead of a PR URL in `metadata.prUrl`. So `gh` is a quality-of-life dependency, not a hard one.

If you want to disable the `gh` path entirely (e.g. for a corporate environment that doesn't allow it), edit `src/prompt.ts` and remove the `gh pr create` line — the rest of the workflow keeps working.

## Specializations

The prompt branches on the agent's `specialization` field. See `src/prompt.ts` for the full text per role.

| Specialization | What the worker does |
|---|---|
| `writer` | implements specs on a branch; pushes; hands off to reviewer |
| `reviewer` | reviews PRs/branches; submits an approve/reject decision via `mcp__relai__submit_review` |
| `tester` | writes/fixes tests on the branch named in `metadata.branchName` |
| `architect` | high-level design + handoff |
| (other) | generic prompt |
