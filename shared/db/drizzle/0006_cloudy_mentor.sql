CREATE TYPE "public"."device_auth_status" AS ENUM('pending', 'approved', 'denied', 'expired');--> statement-breakpoint
CREATE TABLE "device_authorizations" (
	"id" text PRIMARY KEY NOT NULL,
	"user_code" text NOT NULL,
	"device_code_hash" text NOT NULL,
	"status" "device_auth_status" DEFAULT 'pending' NOT NULL,
	"proposed" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"granted" jsonb,
	"repo_id" text,
	"approved_by" text,
	"expires_at" timestamp with time zone NOT NULL,
	"last_polled_at" timestamp with time zone,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "device_authorizations_user_code_unique" UNIQUE("user_code"),
	CONSTRAINT "device_authorizations_device_code_hash_unique" UNIQUE("device_code_hash")
);
--> statement-breakpoint
ALTER TABLE "invites" ADD COLUMN "device_authorization_id" text;--> statement-breakpoint
ALTER TABLE "device_authorizations" ADD CONSTRAINT "device_authorizations_repo_id_repos_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repos"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_authorizations" ADD CONSTRAINT "device_authorizations_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invites" ADD CONSTRAINT "invites_device_authorization_id_device_authorizations_id_fk" FOREIGN KEY ("device_authorization_id") REFERENCES "public"."device_authorizations"("id") ON DELETE cascade ON UPDATE no action;