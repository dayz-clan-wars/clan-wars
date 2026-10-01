ALTER TABLE "feed_entries" DROP CONSTRAINT "feed_entries_source_event_id_events_id_fk";
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "feed_entries" ADD CONSTRAINT "feed_entries_source_event_id_events_id_fk" FOREIGN KEY ("source_event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
