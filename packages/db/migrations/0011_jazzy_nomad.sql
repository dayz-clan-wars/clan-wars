CREATE TABLE IF NOT EXISTS "faction_invites" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"faction_id" bigint NOT NULL,
	"server_id" integer NOT NULL,
	"invitee_discord_id" text NOT NULL,
	"invitee_dayz_id" text NOT NULL,
	"invited_by_discord_id" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"accepted_at" timestamp with time zone,
	"declined_at" timestamp with time zone,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "roster_cooldowns" (
	"server_id" integer NOT NULL,
	"dayz_id" text NOT NULL,
	"until" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "faction_members" ADD COLUMN "server_id" integer NOT NULL;--> statement-breakpoint
ALTER TABLE "factions" ADD COLUMN "renamed_at" timestamp with time zone;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "faction_invites" ADD CONSTRAINT "faction_invites_faction_id_factions_id_fk" FOREIGN KEY ("faction_id") REFERENCES "public"."factions"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "faction_invites" ADD CONSTRAINT "faction_invites_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "roster_cooldowns" ADD CONSTRAINT "roster_cooldowns_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "faction_invites_pending_uniq" ON "faction_invites" USING btree ("faction_id","invitee_dayz_id") WHERE "faction_invites"."accepted_at" IS NULL AND "faction_invites"."declined_at" IS NULL AND "faction_invites"."revoked_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "roster_cooldowns_pk" ON "roster_cooldowns" USING btree ("server_id","dayz_id");--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "faction_members" ADD CONSTRAINT "faction_members_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "faction_members_server_player_uniq" ON "faction_members" USING btree ("server_id","dayz_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "faction_members_leader_uniq" ON "faction_members" USING btree ("faction_id") WHERE "faction_members"."role" = 'leader';