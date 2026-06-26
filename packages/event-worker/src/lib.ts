// Reusable pieces consumed by other packages (e.g. @getrelai/agent's
// self-registering persistent service), separate from index.ts's standalone
// entrypoint.
export { runEventWorker } from "./worker.js";
export { loadConfig } from "./config.js";
export type { EventWorkerConfig } from "./config.js";
