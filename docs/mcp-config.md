# MCP Server Configuration

The `@ai-orchestrator/mcp-server` package works with any MCP-compatible client.
Config format differs per client — the server code is identical.

## Required environment variables

| Variable | Required | Description |
|---|---|---|
| `ORCHESTRATOR_API_URL` | No (default: `http://localhost:3000`) | URL of the running API server |
| `ORCHESTRATOR_API_SECRET` | **Yes** | Shared secret from your `.env` |
| `AGENT_ID` | **Yes** | Your agent's ID (from `POST /agents` on first run) |
| `PROJECT_ID` | **Yes** | The project this agent belongs to |
| `TRANSPORT` | No (default: `stdio`) | `stdio` or `http` |
| `MCP_PORT` | No (default: `3001`) | Port for HTTP transport only |

---

## Claude Code

Add to `~/.claude/settings.json` (global) or `.claude/settings.json` (per-repo):

```json
{
  "mcpServers": {
    "orch": {
      "command": "npx",
      "args": ["@ai-orchestrator/mcp-server"],
      "env": {
        "ORCHESTRATOR_API_URL": "http://localhost:3010",
        "ORCHESTRATOR_API_SECRET": "your-secret",
        "AGENT_ID": "agent_yourAgentId",
        "PROJECT_ID": "proj_yourProjectId"
      }
    }
  }
}
```

---

## GitHub Copilot (VS Code)

Add to `.vscode/mcp.json` in your repo root:

```json
{
  "servers": {
    "orch": {
      "type": "stdio",
      "command": "npx",
      "args": ["@ai-orchestrator/mcp-server"],
      "env": {
        "ORCHESTRATOR_API_URL": "http://localhost:3010",
        "ORCHESTRATOR_API_SECRET": "your-secret",
        "AGENT_ID": "agent_yourAgentId",
        "PROJECT_ID": "proj_yourProjectId"
      }
    }
  }
}
```

> **Note:** Verify the exact `.vscode/mcp.json` format against the current
> GitHub Copilot docs — this format was correct as of the server's authoring
> date but the Copilot MCP integration was still evolving.

---

## Remote / team setup (HTTP transport)

When the API server is hosted remotely and multiple developers connect to it,
run the MCP server in HTTP mode on the API host:

```bash
TRANSPORT=http \
ORCHESTRATOR_API_URL=http://localhost:3000 \
ORCHESTRATOR_API_SECRET=your-secret \
AGENT_ID=agent_yourAgentId \
PROJECT_ID=proj_yourProjectId \
MCP_PORT=3001 \
npx @ai-orchestrator/mcp-server
```

Then configure clients to point at the remote SSE endpoint:

```json
{
  "mcpServers": {
    "orch": {
      "url": "http://your-server:3001/sse"
    }
  }
}
```
