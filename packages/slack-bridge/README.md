# @getrelai/slack-bridge

A demo bridge that connects a **Slack channel** to a **relai thread**, both directions, over Socket Mode. No public URL, nothing to deploy — the app dials out to Slack, so it runs from a laptop and is the same transport the eventual self-hosted deployment uses.

- **Slack → relai**: every non-self message in the channel becomes a relai thread message. A human's reply routes to a blocked task's thread, which the API's blocked-watcher picks up to resume the task.
- **relai → Slack**: subscribed relai events render into the channel — agent messages under each agent's own name/icon (`chat:write.customize`), and human-only attention pings (`Input required`, `Review required`, `Done`).

Because inbound ingests *every* non-self message (not just escalation replies), it is **hybrid**: a registered relai worker (mirrored out via the API) and a teammate's Claude posting straight into Slack both land in the same thread. The loop guard skips only *our* bot's posts, so other bots are ingested.

## Slack app setup

Create an app at https://api.slack.com/apps → "From an app manifest", paste:

```yaml
display_information:
  name: relai
features:
  bot_user:
    display_name: relai
    always_online: true
oauth_config:
  scopes:
    bot:
      - chat:write
      - chat:write.customize
      - channels:history
      - groups:history
      - app_mentions:read
settings:
  event_subscriptions:
    bot_events:
      - message.channels
      - message.groups
  socket_mode_enabled: true
  org_deploy_enabled: false
  token_rotation_enabled: false
```

Then:
1. **Install to workspace** → copy the **Bot User OAuth Token** (`xoxb-…`) → `SLACK_BOT_TOKEN`.
2. **Basic Information → App-Level Tokens** → generate one with the `connections:write` scope (`xapp-…`) → `SLACK_APP_TOKEN`.
3. Invite the bot to your channel: `/invite @relai`. Copy the channel id (right-click the channel → View channel details) → `SLACK_CHANNEL_ID`.

## Environment

| Var | Required | Notes |
|---|---|---|
| `RELAI_TOKEN` | yes | Per-agent relai bearer token. SSE rejects the shared `API_SECRET`, so create a dedicated `slack-bridge` agent and use its token. (`API_SECRET` is accepted as a fallback name.) |
| `AGENT_ID` | yes | The bridge agent's id (used for subscriptions). |
| `REPO_ID` | yes | Repo the bridged thread lives in. |
| `SLACK_BOT_TOKEN` | yes | `xoxb-…` |
| `SLACK_APP_TOKEN` | yes | `xapp-…` (Socket Mode) |
| `SLACK_CHANNEL_ID` | yes | Channel to bridge. |
| `API_URL` | no | Defaults to `http://localhost:3010`. |
| `RELAI_THREAD_ID` | no | Thread to bind. If unset, the bridge creates one on boot and logs its id — set it to reuse the same thread across restarts. |
| `SLACK_USER_MAP` | no | JSON `{ "<slackUserId>": "<relaiAgentId>" }`. Unmapped Slack users are ingested as `"human"`. |
| `AGENT_NAME_MAP` | no | JSON `{ "<relaiAgentId>": "<display name>" }` for outbound post usernames. |
| `RECONNECT_BASE_MS` / `RECONNECT_MAX_MS` | no | SSE backoff (defaults 2s / 60s). |

## Run (demo)

```bash
# 1. Register a dedicated bridge agent and capture its token:
API_SECRET=<secret> tsx scripts/add-agent.ts <repo-id> slack-bridge reviewer
#    then rotate to get a plaintext token:
curl -s -X POST "$API_URL/agents/<agentId>/tokens" -H "Authorization: Bearer <secret>" | jq -r .token

# 2. Put the vars above in the repo-root .env, then:
pnpm --filter @getrelai/slack-bridge dev
```

## Demo flow

1. A task lands in the bound thread and a worker picks it up — status mirrors into `#relai-demo`.
2. Agents coordinate in-channel (status, handoff, PR link).
3. A worker blocks the task (needs auth / a decision) → the bridge posts an **Input required** ping.
4. You reply in Slack → the bridge posts it as `fromAgent: "human"` to the blocked thread → the blocked-watcher resumes the task within ~15s.
5. Verification passes → **Done** posts. Nobody logged into relai; you never left Slack.
