import { loadConfig } from "./config.js";
import { runWorker } from "./worker.js";

const config = loadConfig();

runWorker(config).catch((err) => {
  console.error("[claude-worker] Fatal:", err);
  process.exit(1);
});
