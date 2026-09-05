CREATE TABLE IF NOT EXISTS "faction_join_requests" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"faction_id" bigint NOT NULL,
	"server_id" integer NOT NULL,
	"dayz_id" text NOT NULL,
	"discord_id" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"decided_at" timestamp with time zone,
	"decided_by_discord_id" text,
	"decision" text,
	CONSTRAINT "faction_join_requests_decision_valid" CHECK ("faction_join_requests"."decision" IS NULL OR "faction_join_requests"."decision" IN ('accepted','declined')),
	CONSTRAINT "faction_join_requests_decision_requires_decided" CHECK (("faction_join_requests"."decision" IS NULL) = ("faction_join_requests"."decided_at" IS NULL))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "identity_holds" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"server_id" integer NOT NULL,
	"kind" text NOT NULL,
	"value_lower" text NOT NULL,
	"faction_id" bigint NOT NULL,
	"reason" text NOT NULL,
	"held_until" timestamp with time zone NOT NULL,
	CONSTRAINT "identity_holds_kind_valid" CHECK ("identity_holds"."kind" IN ('name','tag')),
	CONSTRAINT "identity_holds_reason_valid" CHECK ("identity_holds"."reason" IN ('renamed','disbanded'))
);
--> statement-breakpoint
ALTER TABLE "faction_members" ADD COLUMN "status" text DEFAULT 'full' NOT NULL;--> statement-breakpoint
ALTER TABLE "faction_members" ADD COLUMN "pending_since" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "faction_members" ADD COLUMN "seen_at_base_event_id" bigint;--> statement-breakpoint
ALTER TABLE "factions" ADD COLUMN "recruiting" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "factions" ADD COLUMN "play_window" text;--> statement-breakpoint
ALTER TABLE "factions" ADD COLUMN "language" text;--> statement-breakpoint
ALTER TABLE "factions" ADD COLUMN "pitch" text;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "faction_join_requests" ADD CONSTRAINT "faction_join_requests_faction_id_factions_id_fk" FOREIGN KEY ("faction_id") REFERENCES "public"."factions"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "faction_join_requests" ADD CONSTRAINT "faction_join_requests_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "identity_holds" ADD CONSTRAINT "identity_holds_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "identity_holds" ADD CONSTRAINT "identity_holds_faction_id_factions_id_fk" FOREIGN KEY ("faction_id") REFERENCES "public"."factions"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "faction_join_requests_open_uniq" ON "faction_join_requests" USING btree ("faction_id","dayz_id") WHERE "faction_join_requests"."decided_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "identity_holds_uniq" ON "identity_holds" USING btree ("server_id","kind","value_lower");--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "faction_members" ADD CONSTRAINT "faction_members_seen_at_base_event_id_events_id_fk" FOREIGN KEY ("seen_at_base_event_id") REFERENCES "public"."events"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
ALTER TABLE "faction_members" ADD CONSTRAINT "faction_members_status_valid" CHECK ("faction_members"."status" IN ('pending','full'));