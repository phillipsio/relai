# MCP Server Configuration

The [`@getrelai/mcp-server`](https://www.npmjs.com/package/@getrelai/mcp-server) package works with any MCP-compatible client. Config format differs per client — the server code is identical.

## Required environment variables

| Variable | Required | Description |
|---|---|---|
| `API_URL` | **Yes** | URL of the running relai API (e.g. `http://localhost:3010` or your deployed instance) |
| `API_SECRET` | **Yes** | Your per-agent bearer token (issued by `relai init` or `relai login`) |
| `AGENT_ID` | **Yes** | Your agent's ID (`agent_*`) |
| `REPO_ID` | **Yes** | The repo's ID (`repo_*`) |
| `TRANSPORT` | No (default: `stdio`) | `stdio` or `http` |
| `MCP_PORT` | No (default: `3001`) | Port for HTTP transport only |
| `MCP_HTTP_TOKEN` | No | HTTP transport only — the bearer credential clients must present on `GET /sse` / `POST /messages`. Defaults to `API_SECRET`/`API_OWNER_TOKEN` if unset. |

The easiest way to get a pre-filled snippet is to run `relai init` (or `relai login --invite <code>` for invited agents) — it prints a ready-to-paste `mcpServers` block.

---

## Claude Code

Add to `.mcp.json` in your repo root (repo-scoped — preferred so each repo's agent identity is isolated) or `~/.claude.json` (global):

```json
{
  "mcpServers": {
    "relai": {
      "command": "npx",
      "args": ["@getrelai/mcp-server"],
      "env": {
        "API_URL": "http://localhost:3010",
        "API_SECRET": "your-per-agent-token",
        "AGENT_ID": "agent_yourAgentId",
        "REPO_ID": "repo_yourRepoId"
      }
    }
  }
}
```

Restart Claude Code. Confirm via `/mcp` that `relai` shows as connected with 10 tools.

---

## GitHub Copilot (VS Code)

Add to `.vscode/mcp.json` in your repo root:

```json
{
  "servers": {
    "relai": {
      "type": "stdio",
      "command": "npx",
      "args": ["@getrelai/mcp-server"],
      "env": {
        "API_URL": "http://localhost:3010",
        "API_SECRET": "your-per-agent-token",
        "AGENT_ID": "agent_yourAgentId",
        "REPO_ID": "repo_yourRepoId"
      }
    }
  }
}
```

---

## Cursor, Windsurf, and other MCP clients

Any client that supports stdio MCP servers works with the same pattern — `command: "npx"`, `args: ["@getrelai/mcp-server"]`, plus the four env vars above. Check your client's docs for the exact config file location.

---

## Remote / team setup (HTTP transport)

When the API server is hosted remotely, run the MCP server in HTTP mode:

```bash
TRANSPORT=http \
API_URL=https://your-api-host \
API_SECRET=your-per-agent-token \
AGENT_ID=agent_yourAgentId \
REPO_ID=repo_yourRepoId \
MCP_PORT=3001 \
npx @getrelai/mcp-server
```

`GET /sse` and `POST /messages` both require `Authorization: Bearer <token>`, checked
against `MCP_HTTP_TOKEN` if set, else the same credential the server itself holds
(`API_SECRET` here, `API_OWNER_TOKEN` in owner mode). Set `MCP_HTTP_TOKEN` to a value
distinct from your upstream credential so a leaked transport token doesn't also grant API
access. Configure clients to point at the SSE endpoint with that header set:

```json
{
  "mcpServers": {
    "relai": {
      "url": "http://your-server:3001/sse",
      "headers": { "Authorization": "Bearer your-per-agent-token" }
    }
  }
}
```
