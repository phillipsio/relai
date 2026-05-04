# @getrelai/orchestrator

Long-running process that routes pending tasks to worker agents and watches for escalations.

## How it works

Every 15 seconds: fetches pending tasks and routes each one using a two-tier system:

1. **Rules** (free) — domain matching: exact → partial → single-agent fallback
2. **Claude** (256 token cap) — only fires when rules can't resolve

Every 30 seconds: checks for escalation messages and surfaces them to the console.

Every 60 seconds: heartbeat to stay visible as online.

## Running

```bash
ORCHESTRATOR_API_URL=http://localhost:3000 \
ORCHESTRATOR_API_SECRET=your-secret \
AGENT_ID=agent_yourOrchAgentId \
PROJECT_ID=proj_yourProjectId \
ANTHROPIC_API_KEY=sk-ant-... \
pnpm dev
```

## Environment variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `ORCHESTRATOR_API_URL` | No | `http://localhost:3000` | API server URL |
| `ORCHESTRATOR_API_SECRET` | Yes | — | Shared API secret |
| `AGENT_ID` | Yes | — | This orchestrator's agent ID |
| `PROJECT_ID` | Yes | — | Project to orchestrate |
| `ANTHROPIC_API_KEY` | Yes | — | For Claude fallback routing |
| `ORCHESTRATOR_MODEL` | No | `claude-opus-4-6` | Claude model for routing |
| `POLL_INTERVAL_MS` | No | `15000` | Task polling interval |
| `ESCALATION_INTERVAL_MS` | No | `30000` | Escalation check interval |
| `HEARTBEAT_INTERVAL_MS` | No | `60000` | Heartbeat interval |
