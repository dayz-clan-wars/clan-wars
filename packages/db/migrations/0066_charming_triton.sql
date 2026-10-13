CREATE TABLE IF NOT EXISTS "faction_textures" (
	"faction_id" bigint NOT NULL,
	"texture" text NOT NULL,
	"from_at" timestamp with time zone NOT NULL,
	"to_at" timestamp with time zone,
	CONSTRAINT "faction_textures_faction_id_from_at_pk" PRIMARY KEY("faction_id","from_at")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "flag_holds" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"server_id" integer NOT NULL,
	"texture" text NOT NULL,
	"faction_id" bigint NOT NULL,
	"kind" text NOT NULL,
	"until" timestamp with time zone NOT NULL,
	"stamps_cooldown" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "flag_holds_kind_valid" CHECK ("flag_holds"."kind" IN ('pending','released'))
);
--> statement-breakpoint
ALTER TABLE "faction_events" DROP CONSTRAINT "faction_events_kind_valid";--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "faction_textures" ADD CONSTRAINT "faction_textures_faction_id_factions_id_fk" FOREIGN KEY ("faction_id") REFERENCES "public"."factions"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "flag_holds" ADD CONSTRAINT "flag_holds_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "flag_holds" ADD CONSTRAINT "flag_holds_faction_id_factions_id_fk" FOREIGN KEY ("faction_id") REFERENCES "public"."factions"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "faction_textures_one_open" ON "faction_textures" USING btree ("faction_id") WHERE "faction_textures"."to_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "flag_holds_texture_uniq" ON "flag_holds" USING btree ("server_id","texture");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "flag_holds_one_pending" ON "flag_holds" USING btree ("faction_id") WHERE "flag_holds"."kind" = 'pending';--> statement-breakpoint
ALTER TABLE "faction_events" ADD CONSTRAINT "faction_events_kind_valid" CHECK ("faction_events"."kind" IN ('founded','activated','lapsed','renamed','rebound','dormant','revived','disbanded','flag_changed'));--> statement-breakpoint
-- ⚠️ The first faction_textures row comes from this trigger, not from code:
-- every path that inserts a faction (reserve, and every test seed) gets one.
-- from_at '-infinity' keeps upkeep-raise attribution identical to the old
-- `factions.texture` join for a clan that never rebrands.
CREATE OR REPLACE FUNCTION faction_textures_first() RETURNS trigger AS $$
BEGIN
  INSERT INTO faction_textures (faction_id, texture, from_at, to_at)
  VALUES (NEW.id, NEW.texture, '-infinity', NULL);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER faction_textures_first AFTER INSERT ON factions
  FOR EACH ROW EXECUTE FUNCTION faction_textures_first();
--> statement-breakpoint
INSERT INTO faction_textures (faction_id, texture, from_at, to_at)
SELECT id, texture, '-infinity', NULL FROM factions;
