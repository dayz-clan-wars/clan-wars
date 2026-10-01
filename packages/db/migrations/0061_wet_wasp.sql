CREATE TABLE IF NOT EXISTS "feed_entries" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"server_id" integer NOT NULL,
	"kind" text NOT NULL,
	"source_event_id" bigint NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "feed_entries_kind_valid" CHECK ("feed_entries"."kind" IN ('kill','hit','killstreak','long_range')),
	CONSTRAINT "feed_entries_no_coordinates" CHECK (NOT ("feed_entries"."payload"::text ~ '"(pos|victimPos|attackerPos|killerPos|poleKey|x|y|z)": '))
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "feed_entries" ADD CONSTRAINT "feed_entries_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "feed_entries" ADD CONSTRAINT "feed_entries_source_event_id_events_id_fk" FOREIGN KEY ("source_event_id") REFERENCES "public"."events"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "feed_entries_source_uniq" ON "feed_entries" USING btree ("kind","source_event_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "feed_entries_kind_idx" ON "feed_entries" USING btree ("server_id","kind","id");