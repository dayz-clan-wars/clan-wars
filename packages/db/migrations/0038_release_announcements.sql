CREATE TABLE IF NOT EXISTS "release_announcements" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"version" text NOT NULL,
	"released_at" timestamp with time zone NOT NULL,
	"title" text,
	"body" text NOT NULL,
	"queued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"posted_at" timestamp with time zone,
	CONSTRAINT "release_announcements_version_unique" UNIQUE("version")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "release_announcements_queue_idx" ON "release_announcements" USING btree ("id") WHERE "release_announcements"."posted_at" IS NULL;