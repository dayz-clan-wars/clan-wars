CREATE TABLE IF NOT EXISTS "koth_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"server_id" integer NOT NULL,
	"slot_at" timestamp with time zone NOT NULL,
	"location" text NOT NULL,
	"centre_x" numeric(12, 2) NOT NULL,
	"centre_z" numeric(12, 2) NOT NULL,
	"state" text NOT NULL,
	"scheduled_by_discord_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"announced_at" timestamp with time zone,
	"reminded_at" timestamp with time zone,
	"live_posted_at" timestamp with time zone,
	"results_posted_at" timestamp with time zone,
	"cancel_posted_at" timestamp with time zone,
	"loadout_snapshot" jsonb,
	"infected_snapshot" jsonb,
	"opened_at" timestamp with time zone,
	"restored_at" timestamp with time zone,
	"results" jsonb,
	"winner_dayz_id" text,
	"award_grant_id" bigint,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	CONSTRAINT "koth_events_state_valid" CHECK ("koth_events"."state" IN ('scheduled','live','awarded','no_winner','cancelled','failed')),
	CONSTRAINT "koth_events_awarded_has_grant" CHECK (("koth_events"."state" <> 'awarded') OR ("koth_events"."award_grant_id" IS NOT NULL))
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "koth_events" ADD CONSTRAINT "koth_events_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "koth_events" ADD CONSTRAINT "koth_events_award_grant_id_award_grants_id_fk" FOREIGN KEY ("award_grant_id") REFERENCES "public"."award_grants"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "koth_events_one_open" ON "koth_events" USING btree ("server_id") WHERE "koth_events"."state" IN ('scheduled','live');--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "koth_events_slot_uq" ON "koth_events" USING btree ("server_id","slot_at");