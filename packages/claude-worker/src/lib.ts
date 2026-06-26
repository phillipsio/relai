// Reusable pieces consumed by other workers (e.g. @getrelai/event-worker),
// separate from index.ts's standalone poll-loop entrypoint.
export { runClaudeSession } from "./session.js";
export { runWorker, heartbeat, assertRepoOrExit } from "./worker.js";
export { loadConfig, VALID_SPECIALIZATIONS } from "./config.js";
export type { ClaudeWorkerConfig, Specialization } from "./config.js";
