import { spawn } from "node:child_process";

export interface VerificationResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
}

const STREAM_CAP = 8 * 1024;

function appendCapped(buf: string, chunk: string): string {
  if (buf.length >= STREAM_CAP) return buf;
  const remaining = STREAM_CAP - buf.length;
  return buf + chunk.slice(0, remaining);
}

export async function runVerification(
  command: string,
  cwd?: string | null,
  timeoutMs = 60_000,
): Promise<VerificationResult> {
  const start = Date.now();

  return new Promise<VerificationResult>((resolve) => {
    const child = spawn(command, {
      shell: true,
      cwd: cwd ?? process.cwd(),
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;

    const finish = (exitCode: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        exitCode,
        stdout,
        stderr,
        durationMs: Date.now() - start,
        timedOut,
      });
    };

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
      finish(null);
    }, timeoutMs);

    child.stdout?.on("data", (d: Buffer) => { stdout = appendCapped(stdout, d.toString("utf8")); });
    child.stderr?.on("data", (d: Buffer) => { stderr = appendCapped(stderr, d.toString("utf8")); });

    child.on("error", (err) => {
      stderr = appendCapped(stderr, `[spawn error] ${err.message}`);
      finish(null);
    });

    child.on("close", (code) => {
      finish(code);
    });
  });
}
