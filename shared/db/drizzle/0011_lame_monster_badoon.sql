CREATE TABLE "owner_god_agents" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "owner_god_agents_owner_id_unique" UNIQUE("owner_id")
);
--> statement-breakpoint
ALTER TABLE "invites" ADD COLUMN "chain_slot_id" text;--> statement-breakpoint
ALTER TABLE "tokens" ADD COLUMN "chain_slot_id" text;--> statement-breakpoint
ALTER TABLE "owner_god_agents" ADD CONSTRAINT "owner_god_agents_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "owner_god_agents" ADD CONSTRAINT "owner_god_agents_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
INSERT INTO "owner_god_agents" ("id", "owner_id", "agent_id")
SELECT DISTINCT ON ("owner_id")
  'slot_' || substr(md5(random()::text || clock_timestamp()::text), 1, 20),
  "owner_id",
  "agent_id"
FROM "tokens"
WHERE "owner_id" IS NOT NULL AND "revoked_at" IS NULL
ORDER BY "owner_id", "created_at" ASC
ON CONFLICT ("owner_id") DO NOTHING;--> statement-breakpoint
-- Stamp every live owner-scoped token with its owner's slot id.
UPDATE "tokens" t
SET "chain_slot_id" = g."id"
FROM "owner_god_agents" g
WHERE t."owner_id" = g."owner_id" AND t."revoked_at" IS NULL;--> statement-breakpoint
-- Stamp invite descendants of each slot's agent, walking the existing
-- created_by -> accepted_agent_id graph outward. One-time backfill only:
-- it can trace only what that graph still proves reachable today, the same
-- limit the walk it replaces had. Going forward, stamping happens directly
-- at create/accept/rotate time and needs no graph walk at all.
WITH RECURSIVE lineage(agent_id, slot_id) AS (
  SELECT g."agent_id", g."id" FROM "owner_god_agents" g
  UNION
  SELECT i."accepted_agent_id", l.slot_id
  FROM "invites" i
  JOIN lineage l ON i."created_by" = l.agent_id
  WHERE i."accepted_agent_id" IS NOT NULL
)
UPDATE "invites" i
SET "chain_slot_id" = l.slot_id
FROM lineage l
WHERE i."created_by" = l.agent_id;--> statement-breakpoint
-- Stamp the lineage's own tokens, not just the invites it minted. A
-- descendant agent's token carries no owner_id (only the slot's own agent's
-- token does), so the UPDATE above it is blind to it; this is the
-- statement that actually closes the gap the old transitive walk covered
-- via invites.created_by -> tokens.agent_id. Re-derives the same lineage
-- (CTEs don't survive across statements) rather than reusing the one above.
WITH RECURSIVE lineage(agent_id, slot_id) AS (
  SELECT g."agent_id", g."id" FROM "owner_god_agents" g
  UNION
  SELECT i."accepted_agent_id", l.slot_id
  FROM "invites" i
  JOIN lineage l ON i."created_by" = l.agent_id
  WHERE i."accepted_agent_id" IS NOT NULL
)
UPDATE "tokens" t
SET "chain_slot_id" = l.slot_id
FROM lineage l
-- Deliberately NOT filtered to revoked_at IS NULL: a descendant whose only
-- token was revoked before this migration ran (e.g. a peer orchestrator
-- revoked it, pending a rotation) still belongs to the lineage, and leaving
-- it unstamped reopens exactly the hole agents.ts's rotation carry-forward
-- fix closed — its NEXT rotation reads the newest token for the stamp
-- regardless of live status, and a dead, never-stamped row there produces
-- the same unstamped, un-revocable credential the rotation fix exists to
-- prevent. Stamping a dead row is harmless.
WHERE t."agent_id" = l.agent_id AND t."chain_slot_id" IS NULL;