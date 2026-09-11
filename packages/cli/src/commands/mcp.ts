import { spawn } from "node:child_process";
import { join } from "node:path";

export function mcpCommand() {
  const child = spawn(process.execPath, [join(__dirname, "mcp.js"), ...process.argv.slice(3)], { stdio: "inherit" });
  child.on("exit", (code, signal) => process.exit(signal ? 1 : code ?? 0));
}
