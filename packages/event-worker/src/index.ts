import { loadConfig } from "./config.js";
import { runEventWorker } from "./worker.js";

const config = loadConfig();

runEventWorker(config).catch((err) => {
  console.error("[event-worker] Fatal:", err);
  process.exit(1);
});
