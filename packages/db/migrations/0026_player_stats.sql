CREATE TABLE IF NOT EXISTS "kills" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"server_id" integer NOT NULL,
	"event_id" bigint NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"victim_dayz_id" text NOT NULL,
	"killer_dayz_id" text,
	"weapon" text,
	"distance_m" numeric(8, 1),
	"cause" text NOT NULL,
	"victim_faction_id" bigint,
	"killer_faction_id" bigint,
	"friendly_fire" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "membership_history" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"server_id" integer NOT NULL,
	"faction_id" bigint NOT NULL,
	"dayz_id" text NOT NULL,
	"joined_at" timestamp with time zone NOT NULL,
	"left_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "player_sessions" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"server_id" integer NOT NULL,
	"dayz_id" text NOT NULL,
	"connected_at" timestamp with time zone NOT NULL,
	"connect_event_id" bigint NOT NULL,
	"disconnected_at" timestamp with time zone,
	"close_reason" text,
	CONSTRAINT "player_sessions_reason_valid" CHECK ("player_sessions"."close_reason" IS NULL OR "player_sessions"."close_reason" IN ('disconnect','restart')),
	CONSTRAINT "player_sessions_closed_iff_reason" CHECK (("player_sessions"."disconnected_at" IS NULL) = ("player_sessions"."close_reason" IS NULL))
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "kills" ADD CONSTRAINT "kills_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "kills" ADD CONSTRAINT "kills_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "kills" ADD CONSTRAINT "kills_victim_faction_id_factions_id_fk" FOREIGN KEY ("victim_faction_id") REFERENCES "public"."factions"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "kills" ADD CONSTRAINT "kills_killer_faction_id_factions_id_fk" FOREIGN KEY ("killer_faction_id") REFERENCES "public"."factions"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "membership_history" ADD CONSTRAINT "membership_history_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "membership_history" ADD CONSTRAINT "membership_history_faction_id_factions_id_fk" FOREIGN KEY ("faction_id") REFERENCES "public"."factions"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "player_sessions" ADD CONSTRAINT "player_sessions_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "player_sessions" ADD CONSTRAINT "player_sessions_connect_event_id_events_id_fk" FOREIGN KEY ("connect_event_id") REFERENCES "public"."events"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "kills_event_uniq" ON "kills" USING btree ("event_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "kills_victim_idx" ON "kills" USING btree ("server_id","victim_dayz_id","occurred_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "kills_killer_idx" ON "kills" USING btree ("server_id","killer_dayz_id","occurred_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "membership_history_open_uniq" ON "membership_history" USING btree ("faction_id","dayz_id") WHERE "membership_history"."left_at" IS NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "membership_history_player_idx" ON "membership_history" USING btree ("server_id","dayz_id","joined_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "player_sessions_connect_uniq" ON "player_sessions" USING btree ("connect_event_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "player_sessions_open_uniq" ON "player_sessions" USING btree ("server_id","dayz_id") WHERE "player_sessions"."disconnected_at" IS NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "player_sessions_player_idx" ON "player_sessions" USING btree ("server_id","dayz_id","connected_at");