CREATE TABLE IF NOT EXISTS "bans" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"server_id" integer NOT NULL,
	"incident_id" bigint,
	"dayz_id" text NOT NULL,
	"gamertag" text NOT NULL,
	"banned_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone,
	"status" text DEFAULT 'pending' NOT NULL,
	"dry_run" boolean DEFAULT true NOT NULL,
	"applied_at" timestamp with time zone,
	"lifted_at" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "zone_incident_participants" (
	"incident_id" bigint NOT NULL,
	"dayz_id" text NOT NULL,
	"gamertag" text NOT NULL,
	"warned_at" timestamp with time zone,
	CONSTRAINT "zone_incident_participants_incident_id_dayz_id_pk" PRIMARY KEY("incident_id","dayz_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "zone_incidents" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"server_id" integer NOT NULL,
	"declaration_id" bigint NOT NULL,
	"opened_at" timestamp with time zone NOT NULL,
	"last_act_at" timestamp with time zone NOT NULL,
	"closed_at" timestamp with time zone,
	"parts_dismantled" integer DEFAULT 0 NOT NULL,
	"parts_built" integer DEFAULT 0 NOT NULL,
	"stack_items" integer DEFAULT 0 NOT NULL,
	"has_breach" boolean DEFAULT false NOT NULL,
	"has_gate" boolean DEFAULT false NOT NULL,
	"reported_at" timestamp with time zone,
	"reported_by_discord_id" text
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "zone_placements" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"server_id" integer NOT NULL,
	"declaration_id" bigint NOT NULL,
	"event_id" bigint NOT NULL,
	"dayz_id" text NOT NULL,
	"gamertag" text NOT NULL,
	"item_class" text NOT NULL,
	"x" numeric(12, 2) NOT NULL,
	"y" numeric(12, 2) NOT NULL,
	"z" numeric(12, 2) NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "zone_violations" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"incident_id" bigint NOT NULL,
	"event_id" bigint NOT NULL,
	"kind" text NOT NULL,
	"dayz_id" text NOT NULL,
	"what" text NOT NULL,
	"x" numeric(12, 2) NOT NULL,
	"y" numeric(12, 2) NOT NULL,
	"z" numeric(12, 2) NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "bans" ADD CONSTRAINT "bans_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "bans" ADD CONSTRAINT "bans_incident_id_zone_incidents_id_fk" FOREIGN KEY ("incident_id") REFERENCES "public"."zone_incidents"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "zone_incident_participants" ADD CONSTRAINT "zone_incident_participants_incident_id_zone_incidents_id_fk" FOREIGN KEY ("incident_id") REFERENCES "public"."zone_incidents"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "zone_incidents" ADD CONSTRAINT "zone_incidents_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "zone_incidents" ADD CONSTRAINT "zone_incidents_declaration_id_declarations_id_fk" FOREIGN KEY ("declaration_id") REFERENCES "public"."declarations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "zone_placements" ADD CONSTRAINT "zone_placements_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "zone_placements" ADD CONSTRAINT "zone_placements_declaration_id_declarations_id_fk" FOREIGN KEY ("declaration_id") REFERENCES "public"."declarations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "zone_violations" ADD CONSTRAINT "zone_violations_incident_id_zone_incidents_id_fk" FOREIGN KEY ("incident_id") REFERENCES "public"."zone_incidents"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "bans_incident_person_uq" ON "bans" USING btree ("incident_id","dayz_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "bans_work_idx" ON "bans" USING btree ("status","expires_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "bans_person_idx" ON "bans" USING btree ("dayz_id","banned_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "zone_incidents_one_open" ON "zone_incidents" USING btree ("declaration_id") WHERE closed_at IS NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "zone_incidents_closed_idx" ON "zone_incidents" USING btree ("closed_at") WHERE reported_at IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "zone_placements_event_uq" ON "zone_placements" USING btree ("event_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "zone_placements_zone_idx" ON "zone_placements" USING btree ("declaration_id","occurred_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "zone_violations_event_uq" ON "zone_violations" USING btree ("event_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "zone_violations_incident_idx" ON "zone_violations" USING btree ("incident_id");