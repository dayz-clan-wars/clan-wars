CREATE TABLE IF NOT EXISTS "raid_window_announcements" (
	"boundary_at" timestamp with time zone NOT NULL,
	"kind" text NOT NULL,
	"announced_at" timestamp with time zone NOT NULL,
	"outcome" text NOT NULL,
	CONSTRAINT "raid_window_announcements_boundary_at_kind_pk" PRIMARY KEY("boundary_at","kind"),
	CONSTRAINT "raid_window_announcements_kind_valid" CHECK ("raid_window_announcements"."kind" IN ('advance','open','close','failure')),
	CONSTRAINT "raid_window_announcements_outcome_valid" CHECK ("raid_window_announcements"."outcome" IN ('posted','missed'))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "raid_window_flips" (
	"server_id" integer NOT NULL,
	"boundary_at" timestamp with time zone NOT NULL,
	"wanted_disabled" boolean NOT NULL,
	"outcome" text NOT NULL,
	"applied_at" timestamp with time zone,
	"restart_confirmed_at" timestamp with time zone,
	"previous_content" text,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	CONSTRAINT "raid_window_flips_server_id_boundary_at_pk" PRIMARY KEY("server_id","boundary_at"),
	CONSTRAINT "raid_window_flips_outcome_valid" CHECK ("raid_window_flips"."outcome" IN ('applied','refused','failed'))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "raid_window_skips" (
	"opens_at" timestamp with time zone PRIMARY KEY NOT NULL,
	"reason" text NOT NULL,
	"decided_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "raid_window_flips" ADD CONSTRAINT "raid_window_flips_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
