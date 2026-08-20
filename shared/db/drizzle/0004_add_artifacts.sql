CREATE TYPE "public"."artifact_visibility" AS ENUM('repo', 'private');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "artifact_reads" (
	"id" text PRIMARY KEY NOT NULL,
	"artifact_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"version" integer NOT NULL,
	"read_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "artifact_versions" (
	"id" text PRIMARY KEY NOT NULL,
	"artifact_id" text NOT NULL,
	"version" integer NOT NULL,
	"body" text NOT NULL,
	"content_type" text DEFAULT 'text/markdown' NOT NULL,
	"published_by_agent_id" text,
	"task_id" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "artifacts" (
	"id" text PRIMARY KEY NOT NULL,
	"repo_id" text NOT NULL,
	"owner_agent_id" text,
	"name" text NOT NULL,
	"description" text,
	"visibility" "artifact_visibility" DEFAULT 'repo' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "artifact_reads" ADD CONSTRAINT "artifact_reads_artifact_id_artifacts_id_fk" FOREIGN KEY ("artifact_id") REFERENCES "public"."artifacts"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "artifact_reads" ADD CONSTRAINT "artifact_reads_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "artifact_versions" ADD CONSTRAINT "artifact_versions_artifact_id_artifacts_id_fk" FOREIGN KEY ("artifact_id") REFERENCES "public"."artifacts"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "artifact_versions" ADD CONSTRAINT "artifact_versions_published_by_agent_id_agents_id_fk" FOREIGN KEY ("published_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_repo_id_repos_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repos"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_owner_agent_id_agents_id_fk" FOREIGN KEY ("owner_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "artifact_reads_agent_artifact_unique" ON "artifact_reads" USING btree ("artifact_id","agent_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "artifact_versions_artifact_version_unique" ON "artifact_versions" USING btree ("artifact_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "artifacts_repo_name_unique" ON "artifacts" USING btree ("repo_id","name");