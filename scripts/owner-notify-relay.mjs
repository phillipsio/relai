// Turns relai owner-attention webhooks into macOS notifications.
//
// The owner is the notification subject, not a session or a repo: relai already
// resolves event.repoId -> repos.ownerId and fans out to that owner's channels,
// so this listens once and covers every repo. Event-driven, so no polling and
// nothing to keep open.
import http from "node:http";
import { execFile } from "node:child_process";
import { createHmac, timingSafeEqual } from "node:crypto";

const PORT = Number(process.env.RELAY_PORT ?? 4577);
const SECRET = process.env.RELAY_SECRET; // channel secret; unset = accept unsigned (local only)

const TITLE = {
  "task.blocked": "relai: blocked on you",
  "task.blocked_overdue": "relai: still blocked",
  "task.proposed": "relai: proposal to commit",
  "task.proposed_overdue": "relai: proposal waiting",
  "task.pending_verification": "relai: review needed",
  "task.review_overdue": "relai: review overdue",
  "task.stalled": "relai: task stalled",
};

function verify(secret, timestamp, body, signature) {
  const expected = `sha256=${createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex")}`;
  const a = Buffer.from(expected), b = Buffer.from(signature ?? "");
  return a.length === b.length && timingSafeEqual(a, b);
}

function notify(title, message) {
  // execFile, not a shell string: a task title is arbitrary text and would
  // otherwise be interpreted by the shell.
  const esc = (s) => String(s).replace(/["\\]/g, "\\$&").slice(0, 200);
  execFile("/usr/bin/osascript", ["-e", `display notification "${esc(message)}" with title "${esc(title)}"`],
    (err) => { if (err) console.error("[relay] osascript failed:", err.message); });
}

http.createServer((req, res) => {
  if (req.method !== "POST") return void res.writeHead(404).end();
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    if (SECRET && !verify(SECRET, req.headers["x-relai-timestamp"], raw, req.headers["x-relai-signature"])) {
      console.error("[relay] rejected: bad signature");
      return void res.writeHead(401).end();
    }
    try {
      const e = JSON.parse(raw);
      const task = e.payload?.task ?? {};
      const title = TITLE[e.kind] ?? `relai: ${e.kind}`;
      const thread = task.metadata?.blockedThreadId;
      notify(title, `${task.title ?? e.targetId}${thread ? ` — reply on ${thread}` : ""}`);
      console.log(`[relay] ${e.kind} ${e.targetId}`);
    } catch (err) {
      console.error("[relay] bad payload:", err instanceof Error ? err.message : err);
    }
    res.writeHead(200).end("ok");
  });
}).listen(PORT, "127.0.0.1", () => console.log(`[relay] listening on 127.0.0.1:${PORT}`));
