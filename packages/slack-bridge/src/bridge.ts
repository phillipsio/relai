import bolt from "@slack/bolt";
import { RelaiClient, connectEventStream } from "./relai.js";
import { isSelfMessage, resolveFromAgent, renderEvent } from "./mapping.js";
import type { SlackBridgeConfig } from "./config.js";

const { App } = bolt;

// Bridges one Slack channel to one relai thread, both directions:
//   Slack -> relai : every non-self channel message becomes a thread message
//                    (human replies route to a blocked task's thread so the
//                    API's blocked-watcher resumes it).
//   relai -> Slack : subscribed events are rendered into the channel, with
//                    per-agent identity and human-only attention pings.
export async function runBridge(config: SlackBridgeConfig): Promise<void> {
  const relai = new RelaiClient(config.apiUrl, config.apiToken);

  let boundThreadId = config.threadId;
  if (!boundThreadId) {
    const created = await relai.createThread(config.repoId, "Slack bridge");
    boundThreadId = created.id;
    console.log(`[slack-bridge] created bound thread ${boundThreadId} (set RELAI_THREAD_ID to reuse it)`);
  } else {
    console.log(`[slack-bridge] bound to thread ${boundThreadId}`);
  }

  // Subscribe so the stream delivers events for us + the bound thread. Both
  // are idempotent server-side.
  await relai
    .subscribe(config.agentId, "agent", config.agentId)
    .catch((e) => console.warn("[slack-bridge] self-subscribe failed:", e instanceof Error ? e.message : e));
  await relai
    .subscribe(config.agentId, "thread", boundThreadId)
    .catch((e) => console.warn("[slack-bridge] thread-subscribe failed:", e instanceof Error ? e.message : e));

  const app = new App({ token: config.slackBotToken, appToken: config.slackAppToken, socketMode: true });

  // Identify ourselves so the loop guard can skip our own outbound posts.
  const auth = (await app.client.auth.test()) as { user_id?: string; bot_id?: string };
  const self = { userId: auth.user_id, botId: auth.bot_id };
  console.log(`[slack-bridge] bot identity user=${self.userId} bot=${self.botId}`);

  // Human replies must land on a blocked task's blockedThreadId for the
  // blocked-watcher to resume it. Track the latest; fall back to the bound
  // thread for ordinary chatter.
  let pendingBlockThreadId: string | null = null;

  // ---- Inbound: Slack -> relai --------------------------------------------
  app.message(async ({ message }) => {
    const m = message as {
      channel?: string;
      subtype?: string;
      user?: string;
      bot_id?: string;
      text?: string;
      ts?: string;
    };
    if (m.channel !== config.slackChannelId) return;
    // Accept plain user posts (no subtype) and other bots' posts (bot_message —
    // e.g. a teammate's Claude); drop edits/joins/deletes/etc.
    if (m.subtype && m.subtype !== "bot_message") return;
    if (isSelfMessage(m, self)) return;
    if (typeof m.text !== "string" || !m.text.trim()) return;

    const fromAgent = resolveFromAgent(m.user, config.userMap);
    const target = pendingBlockThreadId ?? boundThreadId;
    try {
      await relai.postMessage(target, {
        fromAgent,
        type: "reply",
        body: m.text,
        metadata: { source: "slack", slackTs: m.ts, slackUser: m.user },
      });
      console.log(`[slack-bridge] Slack -> relai thread ${target} as ${fromAgent}`);
    } catch (err) {
      console.error("[slack-bridge] ingest failed:", err instanceof Error ? err.message : err);
    }
  });

  // ---- Outbound: relai -> Slack -------------------------------------------
  connectEventStream(config, (event) => {
    const task = (event.payload as { task?: Record<string, any> }).task ?? {};
    if (event.kind === "task.blocked") {
      const btid = task.metadata?.blockedThreadId;
      if (typeof btid === "string") {
        pendingBlockThreadId = btid;
        relai.subscribe(config.agentId, "thread", btid).catch(() => {});
      }
    } else if (event.kind === "task.updated" && task.status && task.status !== "blocked") {
      pendingBlockThreadId = null;
    }

    const post = renderEvent(event, { agentNames: config.agentNames });
    if (!post) return;
    app.client.chat
      .postMessage({
        channel: config.slackChannelId,
        text: post.text,
        username: post.username,
        icon_emoji: post.iconEmoji,
      })
      .catch((err) => console.error("[slack-bridge] postMessage failed:", err instanceof Error ? err.message : err));
  });

  await app.start();
  console.log(`[slack-bridge] running — Slack #${config.slackChannelId} <-> relai thread ${boundThreadId}`);
}
