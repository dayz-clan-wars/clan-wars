CREATE TABLE IF NOT EXISTS "clan_notices" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"server_id" integer NOT NULL,
	"faction_id" bigint,
	"target" text NOT NULL,
	"discord_target_id" text,
	"kind" text NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"payload" jsonb NOT NULL,
	"posted_at" timestamp with time zone,
	"failed_at" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "clan_notices_target_valid" CHECK ("clan_notices"."target" IN ('channel','dm')),
	CONSTRAINT "clan_notices_dm_has_target" CHECK ("clan_notices"."target" <> 'dm' OR "clan_notices"."discord_target_id" IS NOT NULL),
	CONSTRAINT "clan_notices_no_coordinates" CHECK (NOT ("clan_notices"."payload" ? 'poleKey' OR "clan_notices"."payload" ? 'x' OR "clan_notices"."payload" ? 'y' OR "clan_notices"."payload" ? 'z'))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "defenses" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"faction_id" bigint NOT NULL,
	"season_id" bigint NOT NULL,
	"raised_by_dayz_id" text NOT NULL,
	"event_id" bigint NOT NULL,
	"flag_down_since" timestamp with time zone NOT NULL,
	"defended_at" timestamp with time zone NOT NULL,
	"siege_seconds" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "raids" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"season_id" bigint NOT NULL,
	"server_id" integer NOT NULL,
	"victim_faction_id" bigint NOT NULL,
	"raider_dayz_id" text NOT NULL,
	"raider_faction_id" bigint,
	"first_lower_event_id" bigint NOT NULL,
	"first_lower_at" timestamp with time zone NOT NULL,
	"last_lower_at" timestamp with time zone NOT NULL,
	"last_lower_event_id" bigint NOT NULL,
	"lower_count" integer DEFAULT 1 NOT NULL,
	"points" integer NOT NULL,
	"victim_rank_at_lower" integer,
	"ranked_count_at_lower" integer NOT NULL,
	"week_start" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "season_standings" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"season_id" bigint NOT NULL,
	"faction_id" bigint NOT NULL,
	"points" integer DEFAULT 0 NOT NULL,
	"raids" integer DEFAULT 0 NOT NULL,
	"times_raided" integer DEFAULT 0 NOT NULL,
	"defenses" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "seasons" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"server_id" integer NOT NULL,
	"number" integer NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone,
	"champion_faction_id" bigint
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "war_log_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"server_id" integer NOT NULL,
	"kind" text NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"payload" jsonb NOT NULL,
	"posted_at" timestamp with time zone,
	CONSTRAINT "war_log_events_kind_valid" CHECK ("war_log_events"."kind" IN ('raid','defense','week_closed','season_closed')),
	CONSTRAINT "war_log_events_no_coordinates" CHECK (NOT ("war_log_events"."payload" ? 'poleKey' OR "war_log_events"."payload" ? 'x' OR "war_log_events"."payload" ? 'y' OR "war_log_events"."payload" ? 'z'))
);
--> statement-breakpoint
ALTER TABLE "faction_events" DROP CONSTRAINT "faction_events_kind_valid";--> statement-breakpoint
ALTER TABLE "factions" ADD COLUMN "flag_down_since" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "factions" ADD COLUMN "flag_down_by_dayz_id" text;--> statement-breakpoint
ALTER TABLE "factions" ADD COLUMN "dormant_reason" text;--> statement-breakpoint
ALTER TABLE "factions" ADD COLUMN "disband_warned_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "factions" ADD COLUMN "discord_role_id" text;--> statement-breakpoint
ALTER TABLE "factions" ADD COLUMN "discord_text_channel_id" text;--> statement-breakpoint
ALTER TABLE "factions" ADD COLUMN "discord_voice_channel_id" text;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "clan_notices" ADD CONSTRAINT "clan_notices_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "clan_notices" ADD CONSTRAINT "clan_notices_faction_id_factions_id_fk" FOREIGN KEY ("faction_id") REFERENCES "public"."factions"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "defenses" ADD CONSTRAINT "defenses_faction_id_factions_id_fk" FOREIGN KEY ("faction_id") REFERENCES "public"."factions"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "defenses" ADD CONSTRAINT "defenses_season_id_seasons_id_fk" FOREIGN KEY ("season_id") REFERENCES "public"."seasons"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "defenses" ADD CONSTRAINT "defenses_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "raids" ADD CONSTRAINT "raids_season_id_seasons_id_fk" FOREIGN KEY ("season_id") REFERENCES "public"."seasons"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "raids" ADD CONSTRAINT "raids_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "raids" ADD CONSTRAINT "raids_victim_faction_id_factions_id_fk" FOREIGN KEY ("victim_faction_id") REFERENCES "public"."factions"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "raids" ADD CONSTRAINT "raids_raider_faction_id_factions_id_fk" FOREIGN KEY ("raider_faction_id") REFERENCES "public"."factions"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "raids" ADD CONSTRAINT "raids_first_lower_event_id_events_id_fk" FOREIGN KEY ("first_lower_event_id") REFERENCES "public"."events"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "raids" ADD CONSTRAINT "raids_last_lower_event_id_events_id_fk" FOREIGN KEY ("last_lower_event_id") REFERENCES "public"."events"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "season_standings" ADD CONSTRAINT "season_standings_season_id_seasons_id_fk" FOREIGN KEY ("season_id") REFERENCES "public"."seasons"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "season_standings" ADD CONSTRAINT "season_standings_faction_id_factions_id_fk" FOREIGN KEY ("faction_id") REFERENCES "public"."factions"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "seasons" ADD CONSTRAINT "seasons_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "seasons" ADD CONSTRAINT "seasons_champion_faction_id_factions_id_fk" FOREIGN KEY ("champion_faction_id") REFERENCES "public"."factions"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "war_log_events" ADD CONSTRAINT "war_log_events_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "clan_notices_queue_idx" ON "clan_notices" USING btree ("discord_target_id","id") WHERE "clan_notices"."posted_at" IS NULL AND "clan_notices"."failed_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "defenses_event_uniq" ON "defenses" USING btree ("event_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "raids_first_lower_uniq" ON "raids" USING btree ("first_lower_event_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "raids_victim_recent_idx" ON "raids" USING btree ("victim_faction_id","first_lower_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "raids_week_idx" ON "raids" USING btree ("season_id","week_start");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "season_standings_uniq" ON "season_standings" USING btree ("season_id","faction_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "seasons_open_uniq" ON "seasons" USING btree ("server_id") WHERE "seasons"."ended_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "seasons_number_uniq" ON "seasons" USING btree ("server_id","number");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "war_log_events_queue_idx" ON "war_log_events" USING btree ("id") WHERE "war_log_events"."posted_at" IS NULL;--> statement-breakpoint
ALTER TABLE "faction_events" ADD CONSTRAINT "faction_events_kind_valid" CHECK ("faction_events"."kind" IN ('founded','activated','lapsed','renamed','rebound','dormant','revived','disbanded'));--> statement-breakpoint
ALTER TABLE "factions" ADD CONSTRAINT "factions_dormant_reason_valid" CHECK ("factions"."dormant_reason" IS NULL OR "factions"."dormant_reason" IN ('raided','inactive'));