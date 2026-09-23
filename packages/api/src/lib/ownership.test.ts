// What may an owner do to agents in repos it owns?
//
// Until now the answer was "everything", reached by absence: both guards said
// `if (!request.agent) return true`, so an owner inherited the legacy
// API_SECRET path's unrestricted access rather than being granted anything.
// Same outcome, no decision recorded, and the two move together the moment
// anyone narrows either one.
//
// The decision, now encoded: inside repos it owns, an owner is the tenant. It
// can already delete the whole repo, which takes every agent and token with it,
// so refusing a token rotation would be incoherent rather than safer. The
// boundary is assertRepoAccess, which confines an owner to `repos.ownerId =
// request.ownerId` before either guard is consulted.
//
// The ORDER is the part that matters. task_8nGB_v4A7WSEtInu9HWUR adds
// `tokens.ownerId`, after which one request carries BOTH an agent and an
// ownerId. Agent rules have to win, or an owner-scoped WORKER token becomes a
// master key over every agent in that owner's repos. Today that holds by
// accident, because `!request.agent` happens to be false; these tests make it
// hold on purpose.
import { describe, it, expect } from "vitest";
import type { FastifyRequest } from "fastify";
import { callerMayActOnAgent, callerMayAdministerRepo } from "./ownership.js";

type Agent = NonNullable<FastifyRequest["agent"]>;

const agent = (over: Partial<Agent> = {}) =>
  ({ id: "agent_self", repoId: "repo_1", role: "worker", ...over }) as Agent;

const req = (over: Partial<FastifyRequest>) => over as FastifyRequest;

describe("callerMayActOnAgent: the three auth modes each get their own answer", () => {
  it("a per-agent worker may act on itself and nobody else", () => {
    const r = req({ agent: agent() });
    expect(callerMayActOnAgent(r, "agent_self")).toBe(true);
    expect(callerMayActOnAgent(r, "agent_peer")).toBe(false);
  });

  it("a per-agent orchestrator may act on a peer, having already been repo-scoped", () => {
    const r = req({ agent: agent({ role: "orchestrator" }) });
    expect(callerMayActOnAgent(r, "agent_peer")).toBe(true);
  });

  it("an owner may act on any agent that survived assertAgentAccess", () => {
    // Reaching here at all means the agent sits in a repo this owner owns.
    const r = req({ ownerId: "usr_owner" });
    expect(callerMayActOnAgent(r, "agent_anyone")).toBe(true);
  });

  it("the legacy shared secret stays unrestricted", () => {
    expect(callerMayActOnAgent(req({}), "agent_anyone")).toBe(true);
  });
});

describe("an agent identity outranks an owner scope on the same request", () => {
  // Nothing sets both today: the agent branch of the auth plugin returns before
  // the service-admin branch. task_8nGB makes them coexist, and this is the
  // rule that keeps that from being a privilege escalation.
  it("an owner-scoped WORKER is still bound by the worker rules", () => {
    const r = req({ agent: agent(), ownerId: "usr_owner" });
    expect(callerMayActOnAgent(r, "agent_self")).toBe(true);
    // The whole point: ownerId must not buy what the role does not.
    expect(callerMayActOnAgent(r, "agent_peer")).toBe(false);
  });

  it("an owner-scoped worker cannot administer a repo either", () => {
    const r = req({ agent: agent(), ownerId: "usr_owner" });
    expect(callerMayAdministerRepo(r)).toBe(false);
  });

  it("an owner-scoped orchestrator keeps what its role already gave it", () => {
    const r = req({ agent: agent({ role: "orchestrator" }), ownerId: "usr_owner" });
    expect(callerMayActOnAgent(r, "agent_peer")).toBe(true);
    expect(callerMayAdministerRepo(r)).toBe(true);
  });
});

describe("callerMayAdministerRepo: the three auth modes", () => {
  it("refuses a worker and admits an orchestrator", () => {
    expect(callerMayAdministerRepo(req({ agent: agent() }))).toBe(false);
    expect(callerMayAdministerRepo(req({ agent: agent({ role: "orchestrator" }) }))).toBe(true);
  });

  it("admits an owner, which assertRepoAccess has already confined to its own repos", () => {
    expect(callerMayAdministerRepo(req({ ownerId: "usr_owner" }))).toBe(true);
  });

  it("admits the legacy shared secret", () => {
    expect(callerMayAdministerRepo(req({}))).toBe(true);
  });
});
