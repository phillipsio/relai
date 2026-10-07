import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { and, desc, eq, getTableColumns, gt, inArray, isNull, or } from "drizzle-orm";
import { agents, invites, ownerGodAgents, tokens } from "@getrelai/db";
import type { Db } from "@getrelai/db";

const { codeHash: _codeHash, ...inviteFields } = getTableColumns(invites);

const notFound = { error: { code: "not_found", message: "No top-level agent" } };

// The dashboard acting for a signed-in owner, never an agent: the top-level agent
// must not be able to see or undo its own revocation.
const dashboardOwner = (request: FastifyRequest) => (request.agent ? null : request.ownerId ?? null);

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

// A token's ownerId is the authority grant; chainSlotId is lineage on top of
// it. The two always arrive together through every route that can mint one
// (accept-invite always stamps an owner-scoped grant; rotation always
// carries the existing token's stamp forward) — but a token can exist with
// ownerId set and no stamp if it predates this rebuild, or was written
// directly rather than through a route. The slot and the stamp are how the
// kill switch finds everything going forward; this direct ownerId scan is
// what still reaches that kind of token, since it carries no stamp for the
// slot-based query to match on.
async function directHolders(db: Db | Tx, owner: string): Promise<string[]> {
  const rows = await db.selectDistinct({ agentId: tokens.agentId }).from(tokens)
    .where(and(eq(tokens.ownerId, owner), isNull(tokens.revokedAt)));
  return rows.map((r) => r.agentId);
}

export const ownerRoutes: FastifyPluginAsync<{ db: Db }> = async (fastify, { db }) => {
  fastify.get("/owner/god-agent", async (request, reply) => {
    const owner = dashboardOwner(request);
    if (!owner) return reply.status(404).send(notFound);

    const [slot] = await db.select().from(ownerGodAgents).where(eq(ownerGodAgents.ownerId, owner));
    const ids = [...new Set([...(slot ? [slot.agentId] : []), ...(await directHolders(db, owner))])];
    // A device-auth-minted owner-scope grant invite carries ownerId but no
    // agent yet — createdBy and chainSlotId are both null until it's
    // redeemed (device-auth.ts never sets either). Nothing above can find
    // it, so it needs its own existence check: without this, an outstanding
    // grant that nobody has redeemed is a 404, as if there were nothing to
    // show or kill. Expired is excluded here too — accept-invite refuses an
    // expired code outright, so a grant nobody redeemed in time isn't
    // "outstanding" in any sense this route should report; without the
    // filter, GET answered 200 with an empty agents list forever for a code
    // that could never again become one.
    const [pendingGrant] = await db.select({ id: invites.id }).from(invites)
      .where(and(eq(invites.ownerId, owner), isNull(invites.acceptedAt), isNull(invites.revokedAt), gt(invites.expiresAt, new Date())))
      .limit(1);
    if (ids.length === 0 && !pendingGrant) return reply.status(404).send(notFound);

    const holders = await db.select().from(agents).where(inArray(agents.id, ids));
    // By createdBy, not chainSlotId: a direct holder with no stamp still
    // mints ordinary invites, and those carry no chainSlotId to find them
    // by. ownerId covers the grant invite itself, pending or already
    // redeemed (createdBy stays null on that one either way).
    const minted = await db.select(inviteFields).from(invites)
      .where(or(inArray(invites.createdBy, ids), eq(invites.ownerId, owner))!)
      .orderBy(desc(invites.createdAt));
    return { data: { agents: holders, invites: minted } };
  });

  fastify.post("/owner/god-agent/revoke", async (request, reply) => {
    const owner = dashboardOwner(request);
    if (!owner) return reply.status(404).send(notFound);

    const result = await db.transaction(async (tx) => {
      // Only the slot itself needs a lock: deleting it is what makes a
      // stamped token or invite dead, and nothing else in this transaction
      // depends on a row some other transaction might also be touching. The
      // old transitive-walk design locked the agents rows it was about to
      // revoke too, because ITS enforcement point was this very sweep — a
      // token the sweep missed (e.g. one a concurrent rotation inserted a
      // moment later) stayed live forever. Here the enforcement point is
      // auth time (auth.ts, accept-invite): a token stamped with this slot
      // is dead-on-arrival the instant the slot is gone, however it was
      // minted or whenever the insert that created it actually committed.
      const [slot] = await tx.select().from(ownerGodAgents).where(eq(ownerGodAgents.ownerId, owner)).for("update");
      const directIds = await directHolders(tx, owner);
      const ids = [...new Set([...(slot ? [slot.agentId] : []), ...directIds])];

      const now = new Date();
      const tokenMatch = slot ? or(eq(tokens.chainSlotId, slot.id), eq(tokens.ownerId, owner))! : eq(tokens.ownerId, owner);
      const revokedTokens = await tx.update(tokens).set({ revokedAt: now })
        .where(and(isNull(tokens.revokedAt), tokenMatch))
        .returning({ id: tokens.id, agentId: tokens.agentId });

      // ownerId is unconditional, in BOTH branches. A device-auth-minted
      // owner-scope grant invite that nobody has redeemed yet carries
      // neither createdBy nor chainSlotId (see the matching comment on GET
      // above), so without this arm it outlives the kill switch entirely —
      // redeemable for up to its full TTL after the owner believes
      // everything is revoked, including a second grant approved by mistake
      // (or social-engineered) sitting unnoticed next to the one that got
      // redeemed. This WAS conditioned on `!slot`, to let a second,
      // independently-approved pending grant survive revoking the first —
      // reviewed and reversed: "the kill switch reports total revocation
      // but a live, owner-scoped invite code is still redeemable" is worse
      // than the convenience of not having to re-approve a second grant
      // after using this. If an operator wants one spared, that has to be a
      // deliberate second action, not something this silently assumes.
      const inviteMatch = slot
        ? or(eq(invites.chainSlotId, slot.id), inArray(invites.createdBy, ids), eq(invites.ownerId, owner))!
        : or(inArray(invites.createdBy, ids), eq(invites.ownerId, owner))!;
      const revokedInvites = await tx.update(invites).set({ revokedAt: now })
        .where(and(isNull(invites.acceptedAt), isNull(invites.revokedAt), inviteMatch))
        .returning({ id: invites.id });

      if (!slot && directIds.length === 0 && revokedInvites.length === 0) return null;

      if (slot) await tx.delete(ownerGodAgents).where(eq(ownerGodAgents.id, slot.id));

      const agentsReached = new Set([...ids, ...revokedTokens.map((t) => t.agentId)]).size;
      return { agentsReached, invitesRevoked: revokedInvites.length, tokensRevoked: revokedTokens.length };
    });

    if (!result) return reply.status(404).send(notFound);
    return { data: result };
  });
};
