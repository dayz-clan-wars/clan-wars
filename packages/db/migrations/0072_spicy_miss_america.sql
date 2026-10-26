CREATE TABLE IF NOT EXISTS "well_awards" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"server_id" integer NOT NULL,
	"dayz_id" text NOT NULL,
	"well_brick_event_id" bigint NOT NULL,
	"roof_event_id" bigint NOT NULL,
	"roofed_at" timestamp with time zone NOT NULL,
	"award_grant_id" bigint,
	"award_failure" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "well_awards" ADD CONSTRAINT "well_awards_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "well_awards" ADD CONSTRAINT "well_awards_roof_event_id_events_id_fk" FOREIGN KEY ("roof_event_id") REFERENCES "public"."events"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "well_awards" ADD CONSTRAINT "well_awards_award_grant_id_award_grants_id_fk" FOREIGN KEY ("award_grant_id") REFERENCES "public"."award_grants"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "well_awards_player_well_uq" ON "well_awards" USING btree ("dayz_id","well_brick_event_id");