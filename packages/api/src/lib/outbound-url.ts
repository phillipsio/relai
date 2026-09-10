import { lookup } from "node:dns/promises";

// The API host issues the POST, so the caller picks the SSRF target.

// Eight 16-bit groups, or null when this is not an IPv6 literal. Matching the
// text instead was whack-a-mole; four forms got through it.
function parseV6(input: string): number[] | null {
  let text = input.toLowerCase();
  if (text.includes("%")) return null;                 // zone id, not routable here

  // A trailing dotted quad occupies the last two groups.
  let tail: number[] = [];
  const dotted = /:((\d{1,3}\.){3}\d{1,3})$/.exec(text);
  if (dotted) {
    const o = dotted[1].split(".").map(Number);
    if (o.some((n) => Number.isNaN(n) || n > 255)) return null;
    tail = [(o[0] << 8) | o[1], (o[2] << 8) | o[3]];
    text = text.slice(0, dotted.index + 1);
  }

  const [head, rest, extra] = text.split("::");
  if (extra !== undefined) return null;
  const parse = (part: string) =>
    part === "" ? [] : part.split(":").filter((p) => p !== "").map((p) => parseInt(p, 16));

  const left = parse(head);
  const right = rest === undefined ? [] : parse(rest);
  const groups = [...left, ...right, ...tail];
  if (groups.some((g) => Number.isNaN(g) || g < 0 || g > 0xffff)) return null;

  if (rest === undefined) return groups.length === 8 ? groups : null;
  if (groups.length > 8) return null;
  const fill = new Array(8 - groups.length).fill(0);
  return [...left, ...fill, ...right, ...tail];
}

function isBlockedV4(o: number[]): boolean {
  if (o.length !== 4 || o.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return true;
  const [a, b] = o;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true;              // link-local, incl. 169.254.169.254
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;    // CGNAT
  if (a >= 224) return true;                            // multicast and reserved
  return false;
}

function isBlockedAddress(ip: string): boolean {
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) return isBlockedV4(ip.split(".").map(Number));

  const g = parseV6(ip);
  if (g === null) return true;                          // unparseable, refuse

  // ::/64 is reserved in full: loopback, unspecified, or a v4 address in the
  // low bits. Enumerating those forms invited a miss each time.
  if (g.slice(0, 4).every((x) => x === 0)) return true;
  if (g[0] === 0x64 && g[1] === 0xff9b) return true;    // NAT64, embeds a v4
  if (g[0] === 0x2002) return true;                     // 6to4, embeds a v4
  if ((g[0] & 0xffc0) === 0xfe80) return true;          // fe80::/10 link-local
  if ((g[0] & 0xffc0) === 0xfec0) return true;          // fec0::/10 site-local
  if ((g[0] & 0xfe00) === 0xfc00) return true;          // fc00::/7 unique-local
  if ((g[0] & 0xff00) === 0xff00) return true;          // ff00::/8 multicast
  return false;
}

// Shape check only, no DNS, so a bad URL is refused at insert.
export function outboundUrlProblem(value: string): string | null {
  let url: URL;
  try { url = new URL(value); } catch { return "not a valid URL"; }
  if (url.protocol !== "https:") return "must use https://";
  if (url.hostname.startsWith("-")) return "hostname may not start with '-'";

  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  const bare = host.replace(/\.+$/, "");                // trailing dots are the same name
  if (bare === "localhost" || bare.endsWith(".localhost")) return "may not target localhost";
  if (/^[\d.]+$/.test(bare) || host.includes(":")) {
    if (isBlockedAddress(host.includes(":") ? host : bare)) {
      return "may not target a private or link-local address";
    }
  }
  return null;
}

// A name that resolved publicly at insert can resolve privately later. Node's
// fetch resolves again after this, so a rebind in between still gets through.
export async function resolvesToBlockedAddress(value: string): Promise<boolean> {
  let url: URL;
  try { url = new URL(value); } catch { return true; }
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (/^[\d.]+$/.test(host) || host.includes(":")) return isBlockedAddress(host);
  try {
    const results = await lookup(host, { all: true });
    return results.some((r) => isBlockedAddress(r.address));
  } catch {
    // No address means nothing to reach, so not the SSRF case. Let fetch
    // report the real DNS error.
    return false;
  }
}
