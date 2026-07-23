import { humanizeTaskStatus, type TaskStatus } from "@getrelai/types";
import type { AppEvent, SlackPost } from "./types.js";

// Loop guard: skip messages the bridge itself posted. Matches on OUR bot's
// user id / bot id only — a teammate's Claude (a different bot) is NOT skipped,
// which is what makes the hybrid case (agents posting straight into Slack) work.
export function isSelfMessage(
  msg: { user?: string; bot_id?: string },
  self: { userId?: string; botId?: string },
): boolean {
  if (self.userId && msg.user === self.userId) return true;
  if (self.botId && msg.bot_id === self.botId) return true;
  return false;
}

// Map a Slack author to a relai identity. Known Slack users resolve to their
// agent id; everyone else is "human" (which is what the blocked-task watcher
// keys on to resume a stalled task).
export function resolveFromAgent(slackUserId: string | undefined, userMap: Record<string, string>): string {
  return (slackUserId && userMap[slackUserId]) || "human";
}

function displayName(id: string | undefined, agentNames: Record<string, string>): string {
  if (!id) return "relai";
  if (id === "human") return "human";
  return agentNames[id] ?? id;
}

const RELAI_ICON = ":robot_face:";

// Decide whether and how a relai event surfaces in the Slack channel. Returns
// null for kinds hidden from the demo channel (internal routing chatter,
// proposals, non-status task updates) so the channel reads as coordination,
// not noise.
export function renderEvent(event: AppEvent, opts: { agentNames: Record<string, string> }): SlackPost | null {
  const payload = event.payload as Record<string, any>;
  const names = opts.agentNames;

  switch (event.kind) {
    case "message.posted": {
      const m = payload.message;
      if (!m || typeof m.body !== "string") return null;
      // Belt-and-suspenders echo guard: never re-post a message that came from
      // Slack (the SSE self-echo suppression already covers this, since the
      // bridge is the actor, but tagging is explicit and cheap).
      if (m.metadata?.source === "slack") return null;
      return { text: m.body, username: displayName(m.fromAgent, names), iconEmoji: ":speech_balloon:" };
    }
    case "task.created":
    case "task.committed": {
      const t = payload.task ?? {};
      const who = t.assignedTo ? displayName(t.assignedTo, names) : "unassigned";
      return { text: `:new: *${t.title ?? "task"}* → ${who}`, username: "relai", iconEmoji: RELAI_ICON };
    }
    case "task.blocked": {
      const t = payload.task ?? {};
      const reason = t.metadata?.blockedReason ?? "needs input";
      return {
        text: `:lock: *Input required* — ${t.title ?? "task"}\n> ${reason}\n_Reply in this channel to unblock._`,
        username: "relai",
        iconEmoji: RELAI_ICON,
      };
    }
    case "task.pending_verification": {
      const t = payload.task ?? {};
      return { text: `:eyes: *Review required* — ${t.title ?? "task"}`, username: "relai", iconEmoji: RELAI_ICON };
    }
    case "task.review_requested": {
      const t = payload.task ?? {};
      const reviewer = displayName(payload.reviewerId, names);
      return {
        text: `:eyes: *Review requested* from ${reviewer} — ${t.title ?? "task"}`,
        username: "relai",
        iconEmoji: RELAI_ICON,
      };
    }
    case "task.verified": {
      const t = payload.task ?? {};
      return { text: `:white_check_mark: *Done* — ${t.title ?? "task"} verified`, username: "relai", iconEmoji: RELAI_ICON };
    }
    case "task.verification_failed": {
      const t = payload.task ?? {};
      return {
        text: `:warning: *Verification failed* — ${t.title ?? "task"} (returned to assigned)`,
        username: "relai",
        iconEmoji: RELAI_ICON,
      };
    }
    case "task.updated": {
      const t = payload.task ?? {};
      const changes = payload.changes as Record<string, unknown> | undefined;
      // Only surface status transitions; other field edits stay silent.
      if (!changes || !("status" in changes) || !t.status) return null;
      const label = humanizeTaskStatus({ status: t.status as TaskStatus, autoAssign: t.autoAssign, stalledAt: t.stalledAt });
      return { text: `:arrows_counterclockwise: ${t.title ?? "task"} — _${label}_`, username: "relai", iconEmoji: RELAI_ICON };
    }
    default:
      // stalled / proposed* / proposal_rejected / review_submitted / review_overdue
      // / thread.* — not surfaced to the demo channel.
      return null;
  }
}
