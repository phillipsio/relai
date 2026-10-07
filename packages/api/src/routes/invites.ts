import { promptSafeText, promptSafeDomains, promptSafePath } from "../lib/router/roster.js";
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { and, eq, isNull, getTableColumns } from "drizzle-orm";
import { agents, invites, repos, tokens, ownerGodAgents } from "@getrelai/db";
import type { Db } from "@getrelai/db";
import { newId } from "../lib/id.js";
import { publish } from "../lib/events.js";
import { generateInviteCode, generateToken, hashSecret } from "../lib/tokens.js";
import { assertRepoAccess } from "../lib/ownership.js";
import { isConstraintViolation, ONE_ORCHESTRATOR_PER_REPO, ONE_GOD_AGENT_PER_OWNER } from "../lib/constraints.js";

const DEFAULT_TTL_SECONDS = 60 * 60 * 24 * 7; // 7 days
// Clamped here rather than in the schema: a rejected request tells the caller
// the limit, but the code is the thing that has to be short-lived, and the
// MCP tool that prints one into a chat transcript is not the only caller.
// An unclamped value also overflows Date and 500s past ~3e11 seconds.
const MAX_TTL_SECONDS = DEFAULT_TTL_SECONDS;
const GOD_MINTED_TTL_SECONDS = 60 * 60;

// Named fields, not the row: codeHash must never leave the server. Derived from
// the table rather than typed out, so a column added later cannot silently stop
// being returned.
const { codeHash: _codeHash, ...inviteFields } = getTableColumns(invites);

// The tenant behind a pending super-agent grant is reconnaissance for any repo
// member, and membership is all this route checks. Same treatment as
// GET /agents/:id/tokens: say whether, never who. chainSlotId goes the same
// way as ownerId, not just alongside it: it's an opaque id, but a shared one
// across every invite in the same lineage, so returning it to any repo
// member would let them correlate invites across every repo the owner owns
// — exactly the reconnaissance ownerScoped is here to avoid leaking.
const hideOwner = <T extends { ownerId: string | null; chainSlotId: string | null }>({ ownerId, chainSlotId, ...rest }: T) => ({
  ...rest,
  ownerScoped: ownerId !== null,
});

const createSchema = z.object({
  suggestedName: z.string().min(1).optional(),
  suggestedSpecialization: promptSafeText.min(1).optional(),
  ttlSeconds: z.number().int().positive().optional(),
  // Pinned onto the invite row. Defaults to worker so an unqualified invite can
  // never hand out the privileged role.
  role: z.enum(["orchestrator", "worker"]).optional(),
});

const acceptSchema = z.object({
  code:           z.string().min(1),
  name:           z.string().min(1).max(80).regex(/^[^\r\n]+$/),
  // Advisory only: the granted role comes from the invite. Kept so existing
  // clients keep working, and cross-checked below so a mismatch is refused
  // rather than silently downgraded. Must NOT default, or omitting it would
  // conflict with an orchestrator invite.
  role:           z.enum(["orchestrator", "worker"]).optional(),
  specialization: z.string().min(1).max(80).regex(/^[^\r\n]+$/).optional(),
  workerType:     z.enum(["claude", "copilot", "cursor", "windsurf", "gemini", "gpt", "mcp", "human"]).optional(),
  domains:        promptSafeDomains.default([]),
  repoPath:       promptSafePath.optional(),
});

const MINT_NOTICE_WINDOW_MS = 10 * 60_000;
const lastMintNotice = new Map<string, number>();

class IssuerRevoked extends Error {}
class GodAgentRevoked extends Error {}

export const inviteRoutes: FastifyPluginAsync<{ db: Db }> = async (fastify, { db }) => {
  fastify.post<{ Params: { id: string } }>("/repos/:id/invites", async (request, reply) => {
    const access = await assertRepoAccess(request, db, request.params.id);
    if (!access.ok) return reply.status(access.status).send({ error: { code: access.status === 403 ? "forbidden" : "not_found", message: "Repo not found" } });
    const [project] = await db.select().from(repos).where(eq(repos.id, request.params.id));
    if (!project) return reply.status(404).send({ error: { code: "not_found", message: "Repo not found" } });

    const body = createSchema.safeParse(request.body ?? {});
    if (!body.success) return reply.status(400).send({ error: { code: "validation_error", message: body.error.message } });

    // Minting a privileged invite is itself privileged, or the accepter gate is
    // just moved one hop rather than closed.
    const role = body.data.role ?? "worker";
    if (role === "orchestrator" && request.agent && request.ownerId) {
      return reply.status(403).send({
        error: { code: "forbidden", message: "The top-level agent invites workers only; an orchestrator seat comes from the owner's dashboard." },
      });
    }
    if (role === "orchestrator" && request.agent && request.agent.role !== "orchestrator") {
      return reply.status(403).send({
        error: { code: "forbidden", message: "Only orchestrator agents may issue an orchestrator invite." },
      });
    }

    // Deliberately NOT gated on whether the repo already has an orchestrator:
    // redemption is gated (agents_one_orchestrator_per_repo, enforced below),
    // but a pre-minted orchestrator invite held in reserve is the one in-band
    // recovery path if the incumbent is ever deleted (DELETE /agents/:id
    // refuses removing a repo's sole orchestrator on the agent-token path for
    // exactly this reason) — gating creation here would remove that.
    const code = generateInviteCode();
    const cap  = request.agent && request.ownerId ? GOD_MINTED_TTL_SECONDS : MAX_TTL_SECONDS;
    const ttl  = Math.min(body.data.ttlSeconds ?? cap, cap);
    const [row] = await db.insert(invites).values({
      id:        newId("invite"),
      repoId: project.id,
      codeHash:  hashSecret(code),
      createdBy: request.agent?.id ?? null,
      // Inherited from the presenting token, not looked up: auth already
      // resolved it and confirmed the slot is live, so an invite minted by a
      // stamped agent carries the same lineage forward without this route
      // touching owner_god_agents itself. Null for an ordinary token.
      chainSlotId: request.chainSlotId ?? null,
      role,
      suggestedName:           body.data.suggestedName           ?? null,
      suggestedSpecialization: body.data.suggestedSpecialization ?? null,
      expiresAt: new Date(Date.now() + ttl * 1000),
    }).returning(inviteFields);

    const lineage = request.agent ? request.chainSlotId ?? request.ownerId : null;
    if (request.agent && lineage && Date.now() - (lastMintNotice.get(lineage) ?? 0) >= MINT_NOTICE_WINDOW_MS) {
      lastMintNotice.set(lineage, Date.now());
      await publish(db, {
        id:         newId("evt"),
        kind:       "invite.minted_by_top_level",
        repoId:     project.id,
        targetType: "agent",
        targetId:   request.agent.id,
        actorId:    request.agent.id,
        payload: {
          inviteId:    row.id,
          repoId:      project.id,
          repoName:    project.name,
          role,
          expiresAt:   row.expiresAt.toISOString(),
          mintedBy:    { agentId: request.agent.id, name: request.agent.name },
        },
        createdAt: new Date().toISOString(),
      });
    }

    return reply.status(201).send({ data: hideOwner(row), code });
  });

  fastify.get<{ Params: { id: string } }>("/repos/:id/invites", async (request, reply) => {
    const access = await assertRepoAccess(request, db, request.params.id);
    if (!access.ok) return reply.status(access.status).send({ error: { code: access.status === 403 ? "forbidden" : "not_found", message: "Repo not found" } });
    const [project] = await db.select().from(repos).where(eq(repos.id, request.params.id));
    if (!project) return reply.status(404).send({ error: { code: "not_found", message: "Repo not found" } });

    const rows = await db.select(inviteFields).from(invites).where(eq(invites.repoId, project.id));
    return { data: rows.map(hideOwner) };
  });

  fastify.delete<{ Params: { id: string } }>("/invites/:id", async (request, reply) => {
    const [existing] = await db.select().from(invites).where(eq(invites.id, request.params.id));
    if (!existing) return reply.status(404).send({ error: { code: "not_found", message: "Invite not found" } });
    const access = await assertRepoAccess(request, db, existing.repoId);
    if (!access.ok) return reply.status(access.status).send({ error: { code: access.status === 403 ? "forbidden" : "not_found", message: "Invite not found" } });

    await db.update(invites)
      .set({ revokedAt: new Date() })
      .where(eq(invites.id, request.params.id));
    return reply.status(204).send();
  });

  // Public — must be whitelisted in the auth plugin.
  fastify.post("/auth/accept-invite", async (request, reply) => {
    const body = acceptSchema.safeParse(request.body);
    if (!body.success) return reply.status(400).send({ error: { code: "validation_error", message: body.error.message } });

    const [invite] = await db.select().from(invites).where(eq(invites.codeHash, hashSecret(body.data.code)));
    if (!invite)              return reply.status(400).send({ error: { code: "invalid_invite", message: "Unknown invite code" } });
    if (invite.acceptedAt)    return reply.status(400).send({ error: { code: "invalid_invite", message: "Invite already accepted" } });
    if (invite.revokedAt)     return reply.status(400).send({ error: { code: "invalid_invite", message: "Invite revoked" } });
    if (invite.expiresAt.getTime() < Date.now())
                              return reply.status(400).send({ error: { code: "invalid_invite", message: "Invite expired" } });

    // The invite grants the role. A body value that disagrees is refused rather
    // than downgraded, so an escalation attempt surfaces.
    if (body.data.role && body.data.role !== invite.role) {
      return reply.status(403).send({
        error: { code: "forbidden", message: "This invite does not grant that role" },
      });
    }

    // The conditional stamp is the ONLY consumption guard, the same shape
    // POST /auth/device/token already uses. The checks above are for error
    // messages; they cannot guard, because two concurrent redeems both pass
    // them before either writes. Measured before this: six concurrent accepts
    // of one owner-scoped invite returned six 201s and six tenant-wide
    // credentials on six agent identities, and revoking the one the operator
    // knew about left the rest live.
    const plaintext = generateToken();
    // The insert below can violate agents_one_orchestrator_per_repo. That aborts
    // the whole transaction, so the conditional claim rolls back too and the
    // code stays redeemable — the operator can fix the cause and reuse it rather
    // than minting another.
    let minted: typeof agents.$inferSelect | null;
    try {
      minted = await db.transaction(async (tx) => {
      // Chain-dead check first, before touching the invite row at all.
      // chain_slot_id is immutable once an invite is created, so the value
      // read outside this transaction is already authoritative — nothing
      // can change it out from under us. Ordering it first matters: revoke
      // locks the slot row then the invite rows it's revoking, in that
      // order. Checking this after the claim below would lock them in the
      // opposite order (invite, then slot) and deadlock against a
      // concurrent revoke under exactly the interleaving this is meant to
      // be safe under — reproduced before this fix as a redeem that raced a
      // revoke, lost the deadlock-detection coin flip, and left a live,
      // unrevoked token behind because the revoke that should have caught it
      // silently rolled back instead.
      if (invite.chainSlotId) {
        const [slot] = await tx.select({ id: ownerGodAgents.id }).from(ownerGodAgents)
          .where(eq(ownerGodAgents.id, invite.chainSlotId)).for("update");
        if (!slot) throw new GodAgentRevoked();
      }
      const [claimed] = await tx
        .update(invites)
        .set({ acceptedAt: new Date() })
        .where(and(eq(invites.id, invite.id), isNull(invites.acceptedAt), isNull(invites.revokedAt)))
        .returning();
      if (!claimed) return null;
      if (claimed.createdBy) {
        const [issuerLive] = await tx.select({ id: tokens.id }).from(tokens)
          .where(and(eq(tokens.agentId, claimed.createdBy), isNull(tokens.revokedAt)))
          .limit(1).for("update");
        if (!issuerLive) throw new IssuerRevoked();
      }

      const [agent] = await tx.insert(agents).values({
        id:             newId("agent"),
        repoId:         claimed.repoId,
        name:           body.data.name,
        role:           claimed.role,
        specialization: body.data.specialization ?? claimed.suggestedSpecialization ?? null,
        domains:        body.data.domains,
        workerType:     body.data.workerType ?? null,
        repoPath:       body.data.repoPath ?? null,
        lastSeenAt:     new Date(0),
      }).returning();

      // A direct owner-scoped grant mints a brand-new slot (never reuses
      // one — see owner_god_agents' own comment on why `id` exists at all).
      // Anything else just carries forward whatever the invite inherited,
      // null included. The two cases are mutually exclusive by construction
      // (only a device-auth grant invite ever has ownerId set, and it never
      // has chainSlotId set), so this is a straight either/or, not a merge.
      const godSlotId = claimed.ownerId ? newId("slot") : null;
      if (claimed.ownerId && godSlotId) {
        await tx.insert(ownerGodAgents).values({ id: godSlotId, ownerId: claimed.ownerId, agentId: agent.id });
      }
      const newChainSlotId = godSlotId ?? claimed.chainSlotId;

      await tx.insert(tokens).values({
        id:        newId("tok"),
        agentId:   agent.id,
        // Owner scope rides the invite rather than being decided here, because
        // only the approval knew it. Null for every ordinary invite.
        ownerId:     claimed.ownerId ?? null,
        chainSlotId: newChainSlotId,
        tokenHash:   hashSecret(plaintext),
      });

      await tx.update(invites).set({ acceptedAgentId: agent.id }).where(eq(invites.id, claimed.id));
        return agent;
      });
    } catch (err) {
      if (err instanceof GodAgentRevoked) {
        return reply.status(400).send({ error: { code: "invalid_invite", message: "The top-level agent this invite traces back to has been revoked." } });
      }
      if (err instanceof IssuerRevoked) {
        return reply.status(400).send({ error: { code: "invalid_invite", message: "The agent that issued this invite has been revoked." } });
      }
      if (isConstraintViolation(err, ONE_GOD_AGENT_PER_OWNER)) {
        return reply.status(409).send({
          error: {
            code: "god_agent_exists",
            message: "This account already has a top-level agent. Revoke it from the dashboard first; this code stays valid until it expires.",
          },
        });
      }
      if (isConstraintViolation(err, ONE_ORCHESTRATOR_PER_REPO)) {
        return reply.status(409).send({
          error: {
            code: "conflict",
            message: "This project already has an orchestrator, so this invite cannot be redeemed as one. The code is still valid once that changes.",
          },
        });
      }
      throw err;
    }

    if (!minted) {
      return reply.status(400).send({ error: { code: "invalid_invite", message: "Invite already accepted" } });
    }
    const agent = minted;

    return reply.status(201).send({ data: agent, token: plaintext });
  });
};
