CREATE TABLE IF NOT EXISTS "faction_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"server_id" integer NOT NULL,
	"faction_id" bigint NOT NULL,
	"kind" text NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"payload" jsonb NOT NULL,
	"posted_at" timestamp with time zone,
	CONSTRAINT "faction_events_kind_valid" CHECK ("faction_events"."kind" IN ('founded','activated','renamed','rebound','dormant','revived','disbanded')),
	CONSTRAINT "faction_events_no_coordinates" CHECK (NOT ("faction_events"."payload" ? 'poleKey' OR "faction_events"."payload" ? 'x' OR "faction_events"."payload" ? 'y' OR "faction_events"."payload" ? 'z'))
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "faction_events" ADD CONSTRAINT "faction_events_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "faction_events" ADD CONSTRAINT "faction_events_faction_id_factions_id_fk" FOREIGN KEY ("faction_id") REFERENCES "public"."factions"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "faction_events_queue_idx" ON "faction_events" USING btree ("id") WHERE "faction_events"."posted_at" IS NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "faction_events_faction_idx" ON "faction_events" USING btree ("faction_id","occurred_at");