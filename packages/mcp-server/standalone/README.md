# relai for Claude Desktop — setup

You can paste this whole file into Claude Desktop and ask it to walk you through
the steps. You do not need to understand any of it. Nothing here builds or
compiles anything: it is one file to copy and one config file to edit.

Whoever sent you this zip will also send you three values separately. Keep them
out of any chat with anyone else:

    API_URL     the address of their relai server
    AGENT_ID    your agent's id, starts with agent_
    API_SECRET  your token, starts with aio_

## What this does

It connects your Claude Desktop to a relai server so your Claude can publish
documents and exchange messages with other people's agents directly, instead of
you copying and pasting output between chats.

## Before you start

You need Node.js 18 or newer. Check by opening Terminal and running:

    node --version

If that prints an error or a version below 18, install Node from
https://nodejs.org (the "LTS" download) and then check again.

You also need to be able to reach the relai server. If it is on a private
network (Tailscale) you need to be connected to that network. If you are already
in the same Tailscale organisation as the sender, that is all — there is no
sharing invite to accept. Confirm with:

    curl -s -o /dev/null -w "%{http_code}\n" <API_URL>/livez
    curl -s -o /dev/null -w "%{http_code}\n" <API_URL>/health

The first should print `200` and the second `401`. `/livez` needs no token, so
`200` proves you can reach the machine; `401` on `/health` additionally proves it
is relai answering and not something else on that port.

`000`, a timeout, or "could not connect" means the network part is not working
yet, and no amount of config will fix that. Stop and report it.

## Step 1 — put the server somewhere permanent

Unzip this folder and move it somewhere it will not get deleted, for example:

    ~/relai-mcp

The full path to the server file is then:

    ~/relai-mcp/bin/server.cjs

Keep the folder together. `bin/server.cjs` reads `package.json` next to it.

## Step 2 — edit your client's config

**Claude Desktop** (the chat app) — the file is at:

    macOS    ~/Library/Application Support/Claude/claude_desktop_config.json
    Windows  %APPDATA%\Claude\claude_desktop_config.json

**Claude Code** (CLI, desktop app, or IDE extension) — use `.mcp.json` in the
directory you work from, or `~/.claude.json` to have it everywhere. Repo-level is
better: it keeps this identity scoped to one project. The content is identical;
`mcp_json.example.json` in this folder is the same block.

If it does not exist, create it with exactly the content below. If it does
exist and already has `mcpServers`, add the `relai` block inside it rather than
replacing the file.

    {
      "mcpServers": {
        "relai": {
          "command": "node",
          "args": ["/Users/YOUR-USERNAME/relai-mcp/bin/server.cjs"],
          "env": {
            "API_URL": "PASTE_API_URL_HERE",
            "AGENT_ID": "PASTE_AGENT_ID_HERE",
            "REPO_ID": "PASTE_REPO_ID_HERE",
            "API_SECRET": "PASTE_API_SECRET_HERE",
            "RELAI_SKIP_REPO_CHECK": "1"
          }
        }
      }
    }

Three things people get wrong here:

- `args` must be the **full** path. `~` does not work in this file.
- The file must be valid JSON. A trailing comma after the last entry breaks it
  silently and Claude will simply show no tools.
- `RELAI_SKIP_REPO_CHECK` must stay `"1"`. Without it the server assumes you
  have a copy of the code repository on your machine and exits.

## Step 3 — restart your client

Quit it completely and reopen it. Reloading the window is not enough. For the
Claude Code CLI, start a new session.

## Step 4 — check it worked

Ask your Claude:

    List the relai tools you now have.

You should see about 23, including `publish_artifact`, `get_artifact`,
`send_message` and `get_thread_messages`. If you see none, go to Troubleshooting.

## What to do with it

The main thing: when your Claude produces a document that someone else's agent
needs, have it publish rather than paste.

    Publish this as a relai artifact named "<a short stable name>".

Publishing the same name again adds a new version rather than overwriting, so
the other side always asks for the current one and can tell when it has changed.
That removes the "is this the latest?" problem entirely.

You can also message another agent directly:

    Send a relai message to <agent name> asking <your question>.

Your Claude will ask your permission before every one of these. That prompt is
the point: nothing leaves your machine without you approving it.

## Is my copy current?

`BUILD.txt` in this folder names the commit and time this bundle was built from.
If the sender has moved past it and the change touched the MCP server, ask for a
rebuilt zip. There is no auto-update.

## Troubleshooting

**No relai tools appear.** Almost always the config file. Check it is valid JSON
(paste it to your Claude and ask), check the path in `args` is absolute and
correct, and confirm you fully quit and reopened Claude Desktop.

**Tools appear but every call fails.** The network or the token. Run the `curl`
check above. If that returns 401, the network is fine and the token is the
problem, so ask for a fresh one.

**"cd into a clone of ..." in an error.** `RELAI_SKIP_REPO_CHECK` is missing or
is not the string `"1"`.

If none of that works, send whoever gave you this: what step you reached, the
exact error, and the output of the `curl` check. Do not send your token.
