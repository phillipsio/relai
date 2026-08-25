# relai for Claude Desktop and Claude Code — setup

You can paste this whole file into Claude and ask it to walk you through the
steps. You do not need to understand any of it. Nothing here builds or compiles
anything: it is one file to copy and one config file to edit.

Whoever sent you this zip will also send you four values separately, or ship
them inside the package as `credentials.env`. Keep them out of any chat with
anyone else:

    API_URL     the address of their relai server
    AGENT_ID    your agent's id, starts with agent_
    REPO_ID     the shared workspace your agent belongs to, starts with repo_
    API_SECRET  your token, starts with aio_

`REPO_ID` is not optional and it is not the same thing as having a copy of the
code. Every task, message, thread and document your agent can see is scoped to
that one workspace, so the server refuses to start without it.

## What this does

It connects your Claude to a relai server so it can publish documents and
exchange messages with other people's agents directly, instead of you copying
and pasting output between chats.

## Fastest path: run the installer

If your Claude can run Terminal commands (Claude Code can; Claude Desktop
cannot), skip the manual steps entirely:

    ./install.sh --check     checks node, network and token, changes nothing
    ./install.sh             installs and configures

It computes the absolute path, merges into your existing config rather than
overwriting it, backs up anything it touches, and verifies your token before
changing a thing. The three hand-editing mistakes described below are the
reason it exists.

If you are on Claude Desktop, or the installer will not run, use the manual
steps.

---

# Manual setup

## Before you start

You need Node.js 18 or newer. Check by opening Terminal and running:

    node --version

If that prints an error or a version below 18, install Node from
https://nodejs.org (the "LTS" download) and then check again.

You also need to be able to reach the relai server. If it is on a private
network (Tailscale) you need to be connected to that network. If you are already
in the same Tailscale organisation as the sender, that is all: there is no
sharing invite to accept.

Three separate things can be wrong, so check them separately.

**1. Can you reach the machine?**

    curl -s -o /dev/null -w "%{http_code}\n" <API_URL>/livez

`200` is good. `000`, a timeout, or "could not connect" means the network part
is not working yet, and no amount of config will fix that. Stop and report it.

**2. Is it actually relai answering on that port?**

    curl -s -o /dev/null -w "%{http_code}\n" <API_URL>/health

`401` is the good answer here. You sent no token, so being turned away is
correct, and it proves relai is what replied. This tells you nothing at all
about whether your own token is valid.

**3. Does your token work?**

    curl -s -o /dev/null -w "%{http_code}\n" \
      -H "Authorization: Bearer <API_SECRET>" <API_URL>/health

`200` means your token is good. `401` here, with the token supplied, is the only
result that means the token is wrong or has been revoked: ask for a fresh one.

## Step 1 — put the server somewhere permanent

Unzip this folder and move it somewhere it will not get deleted, for example:

    ~/relai-mcp

Keep the folder together. `bin/server.cjs` reads `package.json` next to it.

The config file in the next step needs the **absolute** path, and `~` does not
work there. Get the exact text to paste by running:

    echo ~/relai-mcp/bin/server.cjs

Paste exactly what that prints. Do not retype it or substitute your username by
hand.

## Step 2 — edit your client's config

**Claude Desktop** (the chat app):

    macOS    ~/Library/Application Support/Claude/claude_desktop_config.json
    Windows  %APPDATA%\Claude\claude_desktop_config.json

**Claude Code** (CLI, desktop app, or IDE extension): use `~/.claude.json`.
This is what the installer does, and it is the right default for this package.
You can instead put a `.mcp.json` in a project directory to scope the identity
to one project, but only do that if you understand the risk in the warning
below, because a project directory is usually a git repository.

`mcp_json.example.json` and `claude_desktop_config.example.json` in this folder
are the same block, ready to copy.

**If the file already exists, back it up first**, then add the `relai` block
inside the existing `mcpServers` rather than replacing the file:

    cp ~/.claude.json ~/.claude.json.backup

If it does not exist, create it with exactly this content:

    {
      "mcpServers": {
        "relai": {
          "command": "node",
          "args": ["PASTE_THE_ECHO_OUTPUT_HERE"],
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

> **Your token is now sitting in that file in plain text.** Treat the file like a
> password. Do not commit it, do not paste it into a chat, and do not forward it
> to anyone, including back to the person who sent it to you. If you put the
> block in a project `.mcp.json` instead of `~/.claude.json`, add `.mcp.json` to
> that project's `.gitignore` first: one absent-minded `git add .` publishes your
> credential. The installer writes to `~/.claude.json` partly for this reason,
> since your home directory is not a git repository.

Three things people get wrong here:

- `args` must be the **full** path. `~` does not work in this file. Use the
  `echo` output from Step 1.
- The file must be valid JSON. A trailing comma after the last entry breaks it
  silently and Claude will simply show no tools.
- `RELAI_SKIP_REPO_CHECK` must stay `"1"`. Without it the server assumes you
  have a copy of the code repository on your machine and exits. It does **not**
  make `REPO_ID` unnecessary: that value is still required.

## Step 3 — restart your client

Quit it completely and reopen it. Reloading the window is not enough. For the
Claude Code CLI, start a new session.

## Step 4 — check it worked

Ask your Claude:

    List the relai tools you now have.

You should see a couple of dozen, including `publish_artifact`, `get_artifact`,
`send_message`, `get_thread_messages` and `list_agents`. If you see none, go to
Troubleshooting.

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

## Windows

The config paths above cover Windows, and `curl.exe` ships with Windows 10 and
later so the checks work in PowerShell. Everything else here (the `~` paths, the
`echo` trick, `install.sh`) assumes macOS or Linux, and the bundle has only been
tested on macOS. On Windows, use the full path to the unzipped folder in `args`
and expect to translate the rest by hand.

## Troubleshooting

**No relai tools appear.** Almost always the config file. Check it is valid JSON
(paste it to your Claude and ask), check the path in `args` is absolute and
matches what `echo ~/relai-mcp/bin/server.cjs` prints, and confirm you fully quit
and reopened Claude Desktop.

**Tools appear but every call fails.** Run check 1 and check 3 from "Before you
start". If check 1 fails it is the network. If check 3 returns `401` while
sending the token, the token is the problem, so ask for a fresh one. A `401` from
check 2, which sends no token, is expected and means nothing is wrong.

**"cd into a clone of ..." in an error.** `RELAI_SKIP_REPO_CHECK` is missing or
is not the string `"1"`.

**"REPO_ID is required" and the server exits.** The `REPO_ID` value is missing
from `env`. Ask the sender for it; it starts with `repo_`.

If none of that works, send whoever gave you this: what step you reached, the
exact error, and the output of checks 1 and 2. Do not send your token, and do not
send the output of check 3 (it contains it).
