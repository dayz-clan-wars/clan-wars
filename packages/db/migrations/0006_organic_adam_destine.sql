CREATE TABLE IF NOT EXISTS "ceremonies" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"server_id" integer NOT NULL,
	"pole_key" text NOT NULL,
	"x" numeric(12, 2) NOT NULL,
	"y" numeric(12, 2) NOT NULL,
	"z" numeric(12, 2) NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"window_end" timestamp with time zone NOT NULL,
	"status" text NOT NULL,
	"detected_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"notified_at" timestamp with time zone,
	CONSTRAINT "ceremonies_status_valid" CHECK ("ceremonies"."status" IN ('provisional','claimed','expired'))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "ceremony_participants" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"ceremony_id" bigint NOT NULL,
	"dayz_id" text NOT NULL,
	"discord_id" text NOT NULL,
	"gamertag" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "white_raises" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"server_id" integer NOT NULL,
	"pole_key" text NOT NULL,
	"dayz_id" text NOT NULL,
	"gamertag" text NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"event_id" bigint NOT NULL,
	"settled_at" timestamp with time zone
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "ceremonies" ADD CONSTRAINT "ceremonies_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "ceremony_participants" ADD CONSTRAINT "ceremony_participants_ceremony_id_ceremonies_id_fk" FOREIGN KEY ("ceremony_id") REFERENCES "public"."ceremonies"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "white_raises" ADD CONSTRAINT "white_raises_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "white_raises" ADD CONSTRAINT "white_raises_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "ceremonies_open_pole_uniq" ON "ceremonies" USING btree ("server_id","pole_key") WHERE "ceremonies"."status" = 'provisional';--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ceremonies_open_idx" ON "ceremonies" USING btree ("expires_at") WHERE "ceremonies"."status" = 'provisional';--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "ceremony_participants_uniq" ON "ceremony_participants" USING btree ("ceremony_id","dayz_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "white_raises_event_uniq" ON "white_raises" USING btree ("event_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "white_raises_pending_idx" ON "white_raises" USING btree ("server_id","pole_key","occurred_at") WHERE "white_raises"."settled_at" IS NULL;