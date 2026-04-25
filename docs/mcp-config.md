# MCP Server Configuration

The `@relai/mcp-server` package works with any MCP-compatible client.
Config format differs per client — the server code is identical.

## Required environment variables

| Variable | Required | Description |
|---|---|---|
| `API_URL` | No (default: `http://localhost:3010`) | URL of the running API server |
| `API_SECRET` | **Yes** | Shared secret from your `.env` |
| `AGENT_ID` | **Yes** | Your agent's ID (from the Agents page or `orch init`) |
| `PROJECT_ID` | **Yes** | The project this agent belongs to |
| `TRANSPORT` | No (default: `stdio`) | `stdio` or `http` |
| `MCP_PORT` | No (default: `3001`) | Port for HTTP transport only |

The easiest way to get a pre-filled config snippet is to register an agent in the dashboard (**Agents → Add agent**) or run `orch init`.

---

## Claude Code

Add to `.mcp.json` in your project root (project-scoped) or `~/.claude.json` (global):

```json
{
  "mcpServers": {
    "relai": {
      "command": "node",
      "args": ["/path/to/relai/packages/mcp-server/dist/index.js"],
      "env": {
        "API_URL": "http://localhost:3010",
        "API_SECRET": "your-secret",
        "AGENT_ID": "agent_yourAgentId",
        "PROJECT_ID": "proj_yourProjectId"
      }
    }
  }
}
```

Replace `/path/to/relai` with the absolute path to your local clone. The dashboard generates this snippet with the correct values after agent registration.

---

## GitHub Copilot (VS Code)

Add to `.vscode/mcp.json` in your repo root:

```json
{
  "servers": {
    "relai": {
      "type": "stdio",
      "command": "node",
      "args": ["/path/to/relai/packages/mcp-server/dist/index.js"],
      "env": {
        "API_URL": "http://localhost:3010",
        "API_SECRET": "your-secret",
        "AGENT_ID": "agent_yourAgentId",
        "PROJECT_ID": "proj_yourProjectId"
      }
    }
  }
}
```

---

## Cursor, Windsurf, and other MCP clients

Any client that supports stdio MCP servers works with the same pattern — point `command` at `node` and `args` at the compiled `dist/index.js`. Check your client's docs for the exact config file location.

---

## Remote / team setup (HTTP transport)

When the API server is hosted remotely, run the MCP server in HTTP mode:

```bash
TRANSPORT=http \
API_URL=https://your-api-host \
API_SECRET=your-secret \
AGENT_ID=agent_yourAgentId \
PROJECT_ID=proj_yourProjectId \
MCP_PORT=3001 \
node packages/mcp-server/dist/index.js
```

Then configure clients to point at the SSE endpoint:

```json
{
  "mcpServers": {
    "relai": {
      "url": "http://your-server:3001/sse"
    }
  }
}
```
