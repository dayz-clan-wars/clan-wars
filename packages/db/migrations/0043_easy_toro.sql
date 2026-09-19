CREATE TABLE IF NOT EXISTS "booster_kit_challenges" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"discord_id" text NOT NULL,
	"target_dayz_id" text NOT NULL,
	"sequence" text[] NOT NULL,
	"progress_index" integer DEFAULT 0 NOT NULL,
	"seen_count" integer DEFAULT 0 NOT NULL,
	"last_matched_event_id" bigint DEFAULT 0 NOT NULL,
	"issued_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"closed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "booster_kit_uploads" (
	"server_id" integer PRIMARY KEY NOT NULL,
	"content_hash" text NOT NULL,
	"uploaded_at" timestamp with time zone NOT NULL,
	"remote_size" integer,
	"remote_modified_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "booster_kits" (
	"discord_id" text PRIMARY KEY NOT NULL,
	"pos_x" numeric(12, 2),
	"pos_y" numeric(12, 2),
	"pos_z" numeric(12, 2),
	"mask" text,
	"eyewear" text,
	"hat" text,
	"jacket" text,
	"pants" text,
	"boots" text,
	"gloves" text,
	"hip_pack" text,
	"backpack" text,
	"placed_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "discord_boosters" (
	"discord_id" text PRIMARY KEY NOT NULL,
	"premium_since" timestamp with time zone NOT NULL,
	"observed_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "booster_kit_uploads" ADD CONSTRAINT "booster_kit_uploads_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "booster_kit_challenges_open_uniq" ON "booster_kit_challenges" USING btree ("discord_id") WHERE "booster_kit_challenges"."closed_at" IS NULL;