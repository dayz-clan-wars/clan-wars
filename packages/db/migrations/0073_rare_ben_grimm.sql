CREATE TABLE IF NOT EXISTS "raid_award_weeks" (
	"season_id" bigint NOT NULL,
	"week_start" timestamp with time zone NOT NULL,
	"faction_id" bigint NOT NULL,
	"leader_discord_id" text NOT NULL,
	"award_grant_id" bigint,
	"closed_at" timestamp with time zone NOT NULL,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	CONSTRAINT "raid_award_weeks_season_id_week_start_pk" PRIMARY KEY("season_id","week_start")
);
--> statement-breakpoint
ALTER TABLE "raids" ALTER COLUMN "ranked_count_at_lower" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "raids" ADD COLUMN "victim_online" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "raids" ADD COLUMN "away" boolean DEFAULT false NOT NULL;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "raid_award_weeks" ADD CONSTRAINT "raid_award_weeks_season_id_seasons_id_fk" FOREIGN KEY ("season_id") REFERENCES "public"."seasons"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "raid_award_weeks" ADD CONSTRAINT "raid_award_weeks_faction_id_factions_id_fk" FOREIGN KEY ("faction_id") REFERENCES "public"."factions"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "raid_award_weeks" ADD CONSTRAINT "raid_award_weeks_award_grant_id_award_grants_id_fk" FOREIGN KEY ("award_grant_id") REFERENCES "public"."award_grants"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
