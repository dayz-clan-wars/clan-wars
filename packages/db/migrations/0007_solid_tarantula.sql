CREATE TABLE IF NOT EXISTS "claim_drafts" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"ceremony_id" bigint NOT NULL,
	"discord_id" text NOT NULL,
	"name" text NOT NULL,
	"tag" text NOT NULL,
	"texture" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "faction_members" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"faction_id" bigint NOT NULL,
	"dayz_id" text NOT NULL,
	"discord_id" text NOT NULL,
	"role" text NOT NULL,
	"joined_at" timestamp with time zone NOT NULL,
	CONSTRAINT "faction_members_role_valid" CHECK ("faction_members"."role" IN ('leader','officer','member'))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "factions" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"server_id" integer NOT NULL,
	"name" text NOT NULL,
	"tag" text NOT NULL,
	"texture" text NOT NULL,
	"pole_key" text NOT NULL,
	"x" numeric(12, 2) NOT NULL,
	"y" numeric(12, 2) NOT NULL,
	"z" numeric(12, 2) NOT NULL,
	"status" text NOT NULL,
	"leader_discord_id" text NOT NULL,
	"ceremony_id" bigint,
	"created_at" timestamp with time zone NOT NULL,
	"reserved_until" timestamp with time zone,
	"activated_at" timestamp with time zone,
	CONSTRAINT "factions_status_valid" CHECK ("factions"."status" IN ('reserved','active','dormant','lapsed','disbanded')),
	CONSTRAINT "factions_reserved_has_deadline" CHECK ("factions"."status" <> 'reserved' OR "factions"."reserved_until" IS NOT NULL)
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "claim_drafts" ADD CONSTRAINT "claim_drafts_ceremony_id_ceremonies_id_fk" FOREIGN KEY ("ceremony_id") REFERENCES "public"."ceremonies"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "faction_members" ADD CONSTRAINT "faction_members_faction_id_factions_id_fk" FOREIGN KEY ("faction_id") REFERENCES "public"."factions"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "factions" ADD CONSTRAINT "factions_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "factions" ADD CONSTRAINT "factions_ceremony_id_ceremonies_id_fk" FOREIGN KEY ("ceremony_id") REFERENCES "public"."ceremonies"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "claim_drafts_ceremony_uniq" ON "claim_drafts" USING btree ("ceremony_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "faction_members_uniq" ON "faction_members" USING btree ("faction_id","dayz_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "factions_holding_texture_uniq" ON "factions" USING btree ("server_id","texture") WHERE "factions"."status" IN ('reserved','active','dormant');--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "factions_holding_tag_uniq" ON "factions" USING btree ("server_id",lower("tag")) WHERE "factions"."status" IN ('reserved','active','dormant');--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "factions_holding_pole_uniq" ON "factions" USING btree ("server_id","pole_key") WHERE "factions"."status" IN ('reserved','active','dormant');