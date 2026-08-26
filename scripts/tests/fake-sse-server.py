#!/usr/bin/env python3
"""Minimal stand-in for relai's /events + /subscriptions, so the watcher scripts
are testable with no API and no credentials. Prints its port on line 1."""
import sys, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

EMIT_AFTER = float(sys.argv[1]) if len(sys.argv) > 1 else -1  # <0 = pings only
# The real API pings every 25s. A tight interval here makes an orphaned curl
# die of SIGPIPE on its own, which hides exactly the leak the tests check for.
PING_EVERY = float(sys.argv[2]) if len(sys.argv) > 2 else 0.25

class H(BaseHTTPRequestHandler):
    def log_message(self, *a): pass

    def do_POST(self):
        self.send_response(201); self.send_header("Content-Length", "2")
        self.end_headers(); self.wfile.write(b"{}")

    def do_GET(self):
        if not self.path.startswith("/events"):
            self.send_response(200); self.send_header("Content-Length", "2")
            self.end_headers(); self.wfile.write(b"{}"); return
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.end_headers()
        start = time.time()
        try:
            while True:
                if 0 <= EMIT_AFTER <= time.time() - start:
                    self.wfile.write(b'data: {"id":"evt_test","kind":"message.posted"}\n\n')
                    self.wfile.flush(); return
                self.wfile.write(b": ping\n\n"); self.wfile.flush()
                time.sleep(PING_EVERY)
        except (BrokenPipeError, ConnectionResetError):
            return

srv = ThreadingHTTPServer(("127.0.0.1", 0), H)
print(srv.server_port, flush=True)
srv.serve_forever()
