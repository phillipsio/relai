CREATE TABLE "owner_god_agents" (
	"owner_id" text PRIMARY KEY NOT NULL,
	"agent_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "owner_god_agents" ADD CONSTRAINT "owner_god_agents_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "owner_god_agents" ADD CONSTRAINT "owner_god_agents_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
INSERT INTO "owner_god_agents" ("owner_id", "agent_id")
SELECT DISTINCT ON ("owner_id") "owner_id", "agent_id"
FROM "tokens"
WHERE "owner_id" IS NOT NULL AND "revoked_at" IS NULL
ORDER BY "owner_id", "created_at" ASC
ON CONFLICT ("owner_id") DO NOTHING;
