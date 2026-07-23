import { loadConfig } from "./config.js";
import { runBridge } from "./bridge.js";

runBridge(loadConfig()).catch((err) => {
  console.error("[slack-bridge] Fatal:", err);
  process.exit(1);
});
