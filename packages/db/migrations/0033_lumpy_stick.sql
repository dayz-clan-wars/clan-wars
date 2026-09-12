CREATE TABLE IF NOT EXISTS "vehicle_wipe_announcements" (
	"wipe_at" timestamp with time zone PRIMARY KEY NOT NULL,
	"announced_at" timestamp with time zone NOT NULL,
	"event_name" text NOT NULL,
	"outcome" text NOT NULL,
	CONSTRAINT "vehicle_wipe_announcements_outcome_valid" CHECK ("vehicle_wipe_announcements"."outcome" IN ('posted','missed'))
);
