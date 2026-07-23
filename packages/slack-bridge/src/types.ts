// Mirror of the API's AppEvent (packages/api/src/lib/events.ts). Only the
// fields the bridge reads are typed; payload stays loose since its shape
// varies by kind.
export interface AppEvent {
  id: string;
  kind: string;
  repoId: string;
  targetType: "thread" | "task" | "agent";
  targetId: string;
  actorId?: string;
  alsoNotify?: Array<{ targetType: string; targetId: string }>;
  payload: Record<string, unknown>;
  createdAt: string;
}

// A rendered Slack post. `username`/`iconEmoji` use chat:write.customize so
// each relai agent shows as itself in the channel.
export interface SlackPost {
  text: string;
  username?: string;
  iconEmoji?: string;
}
