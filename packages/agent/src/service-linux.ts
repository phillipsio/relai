import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, existsSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ServiceSpec } from "./service.js";

function unitDir(): string {
  return join(homedir(), ".config", "systemd", "user");
}

function unitPath(label: string): string {
  return join(unitDir(), `${label}.service`);
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

// systemd unit files are line-oriented: a value containing a newline that's
// interpolated raw (not shell-quoted) could inject an extra directive — e.g.
// a crafted agentId of "x\nExecStartPost=..." from a compromised relai server
// landing in Description=. shellQuote'd values (Environment=/ExecStart=) are
// already safe; this guards the two that aren't.
function assertNoNewline(value: string, fieldName: string): void {
  if (/[\r\n]/.test(value)) {
    throw new Error(`relai-agent: refusing to write a systemd unit — ${fieldName} contains a newline`);
  }
}

export function installLinux(spec: ServiceSpec): void {
  assertNoNewline(spec.agentId, "agentId");
  assertNoNewline(spec.workingDirectory, "workingDirectory");
  mkdirSync(unitDir(), { recursive: true });

  const envLines = Object.entries(spec.env)
    .map(([k, v]) => `Environment=${k}=${shellQuote(v)}`)
    .join("\n");
  const execStart = spec.args.map(shellQuote).join(" ");

  const unit = `[Unit]
Description=relai agent (${spec.agentId})
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=${spec.workingDirectory}
${envLines}
ExecStart=${execStart}
Restart=always
RestartSec=10

[Install]
WantedBy=default.target
`;

  const path = unitPath(spec.label);
  writeFileSync(path, unit, { mode: 0o600 }); // unit's ExecStart carries the relai-agent CLI invocation; not the secret itself (that's read from .mcp.json at runtime)

  execFileSync("systemctl", ["--user", "daemon-reload"]);
  execFileSync("systemctl", ["--user", "enable", "--now", spec.label]);

  // Without lingering, the user's systemd --user instance (and everything in
  // it, including this service) is killed on logout — directly contradicting
  // the package's "always-on" promise on a headless box. Best-effort: needs
  // either root or polkit consent, so don't fail install over it — just warn.
  try {
    execFileSync("loginctl", ["enable-linger", process.env.USER ?? ""]);
  } catch {
    console.warn(
      `relai-agent: WARNING — could not enable lingering for this user (needs root/polkit). ` +
      `Without it, "${spec.label}" stops when you log out. Run "sudo loginctl enable-linger $USER" to fix.`,
    );
  }

  console.log(`relai-agent: installed and started ${spec.label}`);
  console.log(`  unit:   ${path}`);
  console.log(`  status: systemctl --user status ${spec.label}`);
  console.log(`  logs:   journalctl --user -u ${spec.label} -f`);
}

export function uninstallLinux(label: string): void {
  try {
    execFileSync("systemctl", ["--user", "disable", "--now", label], { stdio: "ignore" });
  } catch {
    // already stopped — fine
  }
  const path = unitPath(label);
  if (existsSync(path)) unlinkSync(path);
  try {
    execFileSync("systemctl", ["--user", "daemon-reload"]);
  } catch {
    // best-effort
  }
  console.log(`relai-agent: stopped and removed ${label}`);
}

export function statusLinux(label: string): void {
  try {
    const out = execFileSync("systemctl", ["--user", "status", label], { encoding: "utf8" });
    console.log(out);
  } catch (err) {
    // systemctl exits non-zero for inactive/not-found units but still prints useful output
    const out = (err as { stdout?: Buffer | string })?.stdout;
    console.log(out ? String(out) : `relai-agent: ${label} is not installed/running`);
  }
}
