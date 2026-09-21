CREATE TABLE IF NOT EXISTS "airdrop_events" (
	"server_id" integer NOT NULL,
	"slot_at" timestamp with time zone NOT NULL,
	"location" text NOT NULL,
	"colour" text NOT NULL,
	"decided_at" timestamp with time zone NOT NULL,
	"pop_at_decision" integer NOT NULL,
	"threshold" numeric NOT NULL,
	"state" text NOT NULL,
	"manual" boolean DEFAULT false NOT NULL,
	"announced_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	CONSTRAINT "airdrop_events_server_id_slot_at_pk" PRIMARY KEY("server_id","slot_at"),
	CONSTRAINT "airdrop_events_state_valid" CHECK ("airdrop_events"."state" IN ('announced','live','ended','failed')),
	CONSTRAINT "airdrop_events_colour_valid" CHECK ("airdrop_events"."colour" IN ('blue','orange','yellow'))
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "airdrop_events" ADD CONSTRAINT "airdrop_events_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
