CREATE TABLE IF NOT EXISTS "award_grants" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"award_key" text NOT NULL,
	"discord_id" text NOT NULL,
	"granted_by_discord_id" text NOT NULL,
	"reason" text NOT NULL,
	"picks" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"pos_x" numeric(12, 2),
	"pos_y" numeric(12, 2),
	"pos_z" numeric(12, 2),
	"placed_at" timestamp with time zone,
	"granted_at" timestamp with time zone NOT NULL,
	"place_by" timestamp with time zone NOT NULL,
	"live_from" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "award_uploads" (
	"server_id" integer PRIMARY KEY NOT NULL,
	"content_hash" text NOT NULL,
	"uploaded_at" timestamp with time zone NOT NULL,
	"remote_size" integer,
	"remote_modified_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "booster_kit_challenges" ADD COLUMN "award_grant_id" bigint;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "award_uploads" ADD CONSTRAINT "award_uploads_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "award_grants_discord_idx" ON "award_grants" USING btree ("discord_id");--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "booster_kit_challenges" ADD CONSTRAINT "booster_kit_challenges_award_grant_id_award_grants_id_fk" FOREIGN KEY ("award_grant_id") REFERENCES "public"."award_grants"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
