CREATE TABLE IF NOT EXISTS "ban_announcements" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"server_id" integer NOT NULL,
	"ban_id" bigint,
	"kind" text NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"payload" jsonb NOT NULL,
	"posted_at" timestamp with time zone,
	CONSTRAINT "ban_announcements_kind_valid" CHECK ("ban_announcements"."kind" IN ('applied','lifted','expired')),
	CONSTRAINT "ban_announcements_no_coordinates" CHECK (NOT ("ban_announcements"."payload" ? 'poleKey' OR "ban_announcements"."payload" ? 'x' OR "ban_announcements"."payload" ? 'y' OR "ban_announcements"."payload" ? 'z'))
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "ban_announcements" ADD CONSTRAINT "ban_announcements_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "ban_announcements" ADD CONSTRAINT "ban_announcements_ban_id_bans_id_fk" FOREIGN KEY ("ban_id") REFERENCES "public"."bans"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ban_announcements_queue_idx" ON "ban_announcements" USING btree ("id") WHERE "ban_announcements"."posted_at" IS NULL;