CREATE TABLE IF NOT EXISTS "public_base_bounties" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"season_id" bigint NOT NULL,
	"server_id" integer NOT NULL,
	"faction_id" bigint NOT NULL,
	"pole_key" text NOT NULL,
	"dayz_id" text NOT NULL,
	"kind" text NOT NULL,
	"points" integer NOT NULL,
	"event_id" bigint NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"week_start" timestamp with time zone NOT NULL,
	CONSTRAINT "public_base_bounties_kind_valid" CHECK ("public_base_bounties"."kind" in ('claimed','penalty'))
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "public_base_bounties" ADD CONSTRAINT "public_base_bounties_season_id_seasons_id_fk" FOREIGN KEY ("season_id") REFERENCES "public"."seasons"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "public_base_bounties" ADD CONSTRAINT "public_base_bounties_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "public_base_bounties" ADD CONSTRAINT "public_base_bounties_faction_id_factions_id_fk" FOREIGN KEY ("faction_id") REFERENCES "public"."factions"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "public_base_bounties" ADD CONSTRAINT "public_base_bounties_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "public_base_bounties_event_uniq" ON "public_base_bounties" USING btree ("event_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "public_base_bounties_once_uniq" ON "public_base_bounties" USING btree ("faction_id","server_id","pole_key") WHERE "public_base_bounties"."kind" = 'claimed';--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "public_base_bounties_season_week_idx" ON "public_base_bounties" USING btree ("season_id","week_start");