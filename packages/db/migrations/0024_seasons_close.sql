CREATE TABLE IF NOT EXISTS "alpha_weeks" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"season_id" bigint NOT NULL,
	"week_start" timestamp with time zone NOT NULL,
	"rank" integer NOT NULL,
	"faction_id" bigint NOT NULL,
	"points" integer NOT NULL,
	CONSTRAINT "alpha_weeks_rank_valid" CHECK ("alpha_weeks"."rank" between 1 and 3)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "season_results" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"season_id" bigint NOT NULL,
	"faction_id" bigint NOT NULL,
	"rank" integer NOT NULL,
	"points" integer NOT NULL,
	"raids" integer NOT NULL,
	"times_raided" integer NOT NULL,
	"defenses" integer NOT NULL,
	"status_at_close" text NOT NULL,
	CONSTRAINT "season_results_status_valid" CHECK ("season_results"."status_at_close" in ('active','dormant','disbanded','lapsed','reserved'))
);
--> statement-breakpoint
ALTER TABLE "seasons" ADD COLUMN "week_closed_through" timestamp with time zone;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "alpha_weeks" ADD CONSTRAINT "alpha_weeks_season_id_seasons_id_fk" FOREIGN KEY ("season_id") REFERENCES "public"."seasons"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "alpha_weeks" ADD CONSTRAINT "alpha_weeks_faction_id_factions_id_fk" FOREIGN KEY ("faction_id") REFERENCES "public"."factions"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "season_results" ADD CONSTRAINT "season_results_season_id_seasons_id_fk" FOREIGN KEY ("season_id") REFERENCES "public"."seasons"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "season_results" ADD CONSTRAINT "season_results_faction_id_factions_id_fk" FOREIGN KEY ("faction_id") REFERENCES "public"."factions"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "alpha_weeks_uniq" ON "alpha_weeks" USING btree ("season_id","week_start","rank");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "season_results_uniq" ON "season_results" USING btree ("season_id","faction_id");