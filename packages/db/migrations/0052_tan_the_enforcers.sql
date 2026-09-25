CREATE TABLE IF NOT EXISTS "koth_vote_voters" (
	"vote_id" bigint NOT NULL,
	"discord_id" text NOT NULL,
	"dayz_id" text NOT NULL,
	"ballot" boolean,
	"cast_at" timestamp with time zone,
	CONSTRAINT "koth_vote_voters_vote_id_discord_id_pk" PRIMARY KEY("vote_id","discord_id"),
	CONSTRAINT "koth_vote_voters_cast_iff_ballot" CHECK (("koth_vote_voters"."ballot" IS NULL) = ("koth_vote_voters"."cast_at" IS NULL))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "koth_votes" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"server_id" integer NOT NULL,
	"slot_at" timestamp with time zone NOT NULL,
	"location" text NOT NULL,
	"started_by_discord_id" text NOT NULL,
	"opened_at" timestamp with time zone NOT NULL,
	"closes_at" timestamp with time zone NOT NULL,
	"electorate_size" integer NOT NULL,
	"turnout_floor" integer NOT NULL,
	"channel_id" text,
	"message_id" text,
	"tally_text" text,
	"state" text NOT NULL,
	"closed_at" timestamp with time zone,
	"result_posted_at" timestamp with time zone,
	"koth_event_id" bigint,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	CONSTRAINT "koth_votes_state_valid" CHECK ("koth_votes"."state" IN ('open','passed','failed','void')),
	CONSTRAINT "koth_votes_closed_iff_not_open" CHECK (("koth_votes"."state" = 'open') = ("koth_votes"."closed_at" IS NULL)),
	CONSTRAINT "koth_votes_passed_has_event" CHECK ("koth_votes"."state" <> 'passed' OR "koth_votes"."koth_event_id" IS NOT NULL),
	CONSTRAINT "koth_votes_electorate_min" CHECK ("koth_votes"."electorate_size" >= 5)
);
--> statement-breakpoint
ALTER TABLE "koth_events" ALTER COLUMN "scheduled_by_discord_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "koth_events" ADD COLUMN "origin" text DEFAULT 'admin' NOT NULL;--> statement-breakpoint
ALTER TABLE "koth_events" ADD COLUMN "pop_at_decision" integer;--> statement-breakpoint
ALTER TABLE "koth_events" ADD COLUMN "threshold" numeric;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "koth_vote_voters" ADD CONSTRAINT "koth_vote_voters_vote_id_koth_votes_id_fk" FOREIGN KEY ("vote_id") REFERENCES "public"."koth_votes"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "koth_votes" ADD CONSTRAINT "koth_votes_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "koth_votes" ADD CONSTRAINT "koth_votes_koth_event_id_koth_events_id_fk" FOREIGN KEY ("koth_event_id") REFERENCES "public"."koth_events"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "koth_votes_one_open" ON "koth_votes" USING btree ("server_id") WHERE "koth_votes"."state" = 'open';--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "koth_votes_slot_uq" ON "koth_votes" USING btree ("server_id","slot_at");--> statement-breakpoint
ALTER TABLE "koth_events" ADD CONSTRAINT "koth_events_origin_valid" CHECK ("koth_events"."origin" IN ('admin','auto','vote'));--> statement-breakpoint
ALTER TABLE "koth_events" ADD CONSTRAINT "koth_events_origin_scheduler" CHECK (("koth_events"."origin" = 'auto') = ("koth_events"."scheduled_by_discord_id" IS NULL));