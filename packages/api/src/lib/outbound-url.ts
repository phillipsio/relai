import { lookup } from "node:dns/promises";

// A notification channel makes the API host issue a POST to an address the
// caller chose, so the usual SSRF targets apply: cloud metadata endpoints,
// anything on the box itself, anything else on the private network.

function isBlockedAddress(ip: string): boolean {
  // WHATWG URL normalises ::ffff:127.0.0.1 to ::ffff:7f00:1, so the dotted
  // form never survives parsing and the hex form has to be unpacked.
  const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(ip);
  if (mapped) {
    const hi = parseInt(mapped[1], 16), lo = parseInt(mapped[2], 16);
    ip = [hi >> 8, hi & 0xff, lo >> 8, lo & 0xff].join(".");
  } else if (ip.startsWith("::ffff:")) {
    ip = ip.slice(7);
  }

  if (ip.includes(":")) {
    const v6 = ip.toLowerCase();
    if (v6 === "::1" || v6 === "::") return true;
    if (v6.startsWith("fe80")) return true;                 // link-local
    if (/^f[cd]/.test(v6)) return true;                     // unique-local
    return false;
  }

  const p = ip.split(".").map(Number);
  if (p.length !== 4 || p.some((n) => Number.isNaN(n))) return true;
  const [a, b] = p;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true;                  // link-local, incl. 169.254.169.254
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;        // CGNAT
  if (a >= 224) return true;                                // multicast, reserved
  return false;
}

// Shape check only, no DNS. Used by the zod schema so a bad URL is refused at
// insert rather than discovered at delivery.
export function outboundUrlProblem(value: string): string | null {
  let url: URL;
  try { url = new URL(value); } catch { return "not a valid URL"; }
  if (url.protocol !== "https:") return "must use https://";
  if (url.hostname.startsWith("-")) return "hostname may not start with '-'";
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost")) return "may not target localhost";
  // A literal address can be judged now; a name needs DNS, done at delivery.
  if (/^[\d.]+$/.test(host) || host.includes(":")) {
    if (isBlockedAddress(host)) return "may not target a private or link-local address";
  }
  return null;
}

// Delivery-time check, because a name that resolved publicly at insert can
// resolve to 169.254.169.254 later. Node's fetch resolves again after this,
// so a rebind between the two still gets through; closing that needs a custom
// agent pinned to the address we checked.
export async function resolvesToBlockedAddress(value: string): Promise<boolean> {
  let url: URL;
  try { url = new URL(value); } catch { return true; }
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (/^[\d.]+$/.test(host) || host.includes(":")) return isBlockedAddress(host);
  try {
    const results = await lookup(host, { all: true });
    return results.some((r) => isBlockedAddress(r.address));
  } catch {
    // No address means nothing to reach, so this is not the SSRF case. Let
    // fetch fail on its own and report the real DNS error to the operator.
    return false;
  }
}
