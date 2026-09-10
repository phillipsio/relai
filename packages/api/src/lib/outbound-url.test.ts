import { describe, it, expect } from "vitest";
import { outboundUrlProblem, resolvesToBlockedAddress } from "./outbound-url.js";

describe("outboundUrlProblem", () => {
  it("accepts an ordinary https URL", () => {
    expect(outboundUrlProblem("https://hooks.example.com/abc")).toBeNull();
  });

  it("refuses plain http, since delivery carries the event payload", () => {
    expect(outboundUrlProblem("http://hooks.example.com/abc")).toBe("must use https://");
  });

  it.each([
    ["cloud metadata",       "https://169.254.169.254/latest/meta-data/"],
    ["loopback v4",          "https://127.0.0.1/x"],
    ["loopback name",        "https://localhost/x"],
    ["loopback subdomain",   "https://foo.localhost/x"],
    ["private 10/8",         "https://10.1.2.3/x"],
    ["private 172.16/12",    "https://172.20.0.1/x"],
    ["private 192.168/16",   "https://192.168.1.1/x"],
    ["CGNAT 100.64/10",      "https://100.64.0.1/x"],
    ["this-network 0/8",     "https://0.0.0.0/x"],
    ["multicast",            "https://239.1.1.1/x"],
    ["v6 loopback",          "https://[::1]/x"],
    ["v6 link-local",        "https://[fe80::1]/x"],
    ["v6 unique-local",      "https://[fd00::1]/x"],
    ["v4-mapped loopback",   "https://[::ffff:127.0.0.1]/x"],
    ["v4-mapped metadata",   "https://[::ffff:169.254.169.254]/x"],
    ["localhost, trailing dot", "https://localhost./x"],
    ["v6 fe80 upper range",  "https://[febf::1]/x"],
    ["v6 multicast",         "https://[ff02::1]/x"],
    ["v6 ::a.b.c.d form",    "https://[::127.0.0.1]/x"],
    ["v6 mapped, 3-group",   "https://[::ffff:0:127.0.0.1]/x"],
    ["v6 NAT64 metadata",    "https://[64:ff9b::169.254.169.254]/x"],
    ["v6 6to4",              "https://[2002:7f00:1::1]/x"],
    ["v6 site-local",        "https://[fec0::1]/x"],
    ["localhost, two dots",  "https://localhost../x"],
  ])("refuses %s", (_label, url) => {
    expect(outboundUrlProblem(url)).not.toBeNull();
  });

  it("refuses a hostname starting with '-', matching repoUrl's rule", () => {
    expect(outboundUrlProblem("https://-evil.example.com/x")).toBe("hostname may not start with '-'");
  });

  it("refuses something that is not a URL at all", () => {
    expect(outboundUrlProblem("not a url")).toBe("not a valid URL");
  });

  it("allows a public address that merely looks adjacent to a private range", () => {
    expect(outboundUrlProblem("https://172.32.0.1/x")).toBeNull();
    expect(outboundUrlProblem("https://100.128.0.1/x")).toBeNull();
    expect(outboundUrlProblem("https://11.0.0.1/x")).toBeNull();
  });
});

describe("resolvesToBlockedAddress", () => {
  it("blocks a literal private address without touching DNS", async () => {
    expect(await resolvesToBlockedAddress("https://169.254.169.254/x")).toBe(true);
  });

  it("blocks a name that resolves to loopback", async () => {
    // localhost resolves to 127.0.0.1 or ::1 on every machine this runs on.
    expect(await resolvesToBlockedAddress("https://localhost/x")).toBe(true);
  });

  it("does not block a name that fails to resolve, since it reaches nothing", async () => {
    expect(await resolvesToBlockedAddress("https://nx.invalid/x")).toBe(false);
  });
});
