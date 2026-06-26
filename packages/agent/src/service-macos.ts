import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, existsSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ServiceSpec } from "./service.js";

function plistPath(label: string): string {
  return join(homedir(), "Library", "LaunchAgents", `${label}.plist`);
}

function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// `?? 0` would silently fall back to root's launchd domain (gui/0) if
// getuid() were ever unavailable — wrong, not safe. This module is only
// reached on darwin (gated in service.ts), where getuid() always exists.
function currentUid(): number {
  if (!process.getuid) throw new Error("process.getuid is unavailable — this should be unreachable on macOS");
  return process.getuid();
}

export function installMacOS(spec: ServiceSpec): void {
  const logDir = join(homedir(), "Library", "Logs", "relai");
  mkdirSync(logDir, { recursive: true });
  mkdirSync(join(homedir(), "Library", "LaunchAgents"), { recursive: true });

  const logPath = join(logDir, `worker-${spec.agentId}.log`);
  const envEntries = Object.entries(spec.env)
    .map(([k, v]) => `    <key>${escapeXml(k)}</key><string>${escapeXml(v)}</string>`)
    .join("\n");
  const argEntries = spec.args.map((a) => `    <string>${escapeXml(a)}</string>`).join("\n");

  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${escapeXml(spec.label)}</string>
  <key>ProgramArguments</key>
  <array>
${argEntries}
  </array>
  <key>WorkingDirectory</key><string>${escapeXml(spec.workingDirectory)}</string>
  <key>EnvironmentVariables</key>
  <dict>
${envEntries}
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>${escapeXml(logPath)}</string>
  <key>StandardErrorPath</key><string>${escapeXml(logPath)}</string>
</dict>
</plist>
`;

  const path = plistPath(spec.label);
  writeFileSync(path, plist, { mode: 0o600 }); // plist carries a live agent token (EnvironmentVariables.API_SECRET)

  const uid = currentUid();
  try {
    execFileSync("launchctl", ["bootout", `gui/${uid}/${spec.label}`], { stdio: "ignore" });
  } catch {
    // not loaded yet — fine
  }
  execFileSync("launchctl", ["bootstrap", `gui/${uid}`, path]);
  execFileSync("launchctl", ["enable", `gui/${uid}/${spec.label}`]);

  console.log(`relai-agent: installed and started ${spec.label}`);
  console.log(`  plist: ${path}`);
  console.log(`  logs:  ${logPath}`);
  console.log(`  status: launchctl print gui/${uid}/${spec.label}`);
}

export function uninstallMacOS(label: string): void {
  const uid = currentUid();
  try {
    execFileSync("launchctl", ["bootout", `gui/${uid}/${label}`], { stdio: "ignore" });
  } catch {
    // already stopped — fine
  }
  const path = plistPath(label);
  if (existsSync(path)) unlinkSync(path);
  console.log(`relai-agent: stopped and removed ${label}`);
}

export function statusMacOS(label: string): void {
  const uid = currentUid();
  try {
    const out = execFileSync("launchctl", ["print", `gui/${uid}/${label}`], { encoding: "utf8" });
    console.log(out);
  } catch {
    console.log(`relai-agent: ${label} is not installed/running`);
  }
}
