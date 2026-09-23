CREATE TYPE "public"."device_grant_scope" AS ENUM('repo', 'owner');--> statement-breakpoint
ALTER TABLE "device_authorizations" ADD COLUMN "scope" "device_grant_scope" DEFAULT 'repo' NOT NULL;--> statement-breakpoint
ALTER TABLE "invites" ADD COLUMN "owner_id" text;--> statement-breakpoint
ALTER TABLE "invites" ADD CONSTRAINT "invites_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;