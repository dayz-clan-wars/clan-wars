CREATE TABLE IF NOT EXISTS "clan_pins" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"faction_id" bigint NOT NULL,
	"dayz_id" text NOT NULL,
	"x" numeric(12, 2) NOT NULL,
	"z" numeric(12, 2) NOT NULL,
	"icon" text NOT NULL,
	"note" text,
	"created_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "clan_pins_icon_valid" CHECK ("clan_pins"."icon" IN ('loot','vehicle','enemy','meet','danger','note'))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "intruder_sightings" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"declaration_id" bigint NOT NULL,
	"dayz_id" text NOT NULL,
	"first_seen_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL,
	"last_alert_at" timestamp with time zone NOT NULL,
	"distance_m" integer NOT NULL,
	"last_x" numeric(12, 2) NOT NULL,
	"last_z" numeric(12, 2) NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "player_positions" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"server_id" integer NOT NULL,
	"dayz_id" text NOT NULL,
	"x" numeric(12, 2) NOT NULL,
	"z" numeric(12, 2) NOT NULL,
	"alt" numeric(12, 2) NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"event_id" bigint NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "clan_pins" ADD CONSTRAINT "clan_pins_faction_id_factions_id_fk" FOREIGN KEY ("faction_id") REFERENCES "public"."factions"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "intruder_sightings" ADD CONSTRAINT "intruder_sightings_declaration_id_declarations_id_fk" FOREIGN KEY ("declaration_id") REFERENCES "public"."declarations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "player_positions" ADD CONSTRAINT "player_positions_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "player_positions" ADD CONSTRAINT "player_positions_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "clan_pins_faction_idx" ON "clan_pins" USING btree ("faction_id","expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "intruder_sightings_uniq" ON "intruder_sightings" USING btree ("declaration_id","dayz_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "intruder_sightings_last_seen_idx" ON "intruder_sightings" USING btree ("last_seen_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "player_positions_event_uniq" ON "player_positions" USING btree ("event_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "player_positions_player_idx" ON "player_positions" USING btree ("server_id","dayz_id","occurred_at" desc);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "player_positions_occurred_idx" ON "player_positions" USING btree ("occurred_at");