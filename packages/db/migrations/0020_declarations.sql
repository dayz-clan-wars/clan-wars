CREATE TABLE IF NOT EXISTS "declarations" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"server_id" integer NOT NULL,
	"pole_key" text NOT NULL,
	"x" numeric(12, 2) NOT NULL,
	"y" numeric(12, 2) NOT NULL,
	"z" numeric(12, 2) NOT NULL,
	"owner_faction_id" bigint,
	"owner_dayz_id" text,
	"evidence_event_id" bigint,
	"evidence_ceremony_id" bigint,
	"declared_at" timestamp with time zone NOT NULL,
	CONSTRAINT "declarations_one_owner" CHECK (("declarations"."owner_faction_id" IS NULL) <> ("declarations"."owner_dayz_id" IS NULL)),
	CONSTRAINT "declarations_one_evidence" CHECK (("declarations"."evidence_event_id" IS NULL) <> ("declarations"."evidence_ceremony_id" IS NULL))
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "declarations" ADD CONSTRAINT "declarations_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "declarations" ADD CONSTRAINT "declarations_owner_faction_id_factions_id_fk" FOREIGN KEY ("owner_faction_id") REFERENCES "public"."factions"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "declarations" ADD CONSTRAINT "declarations_evidence_event_id_events_id_fk" FOREIGN KEY ("evidence_event_id") REFERENCES "public"."events"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "declarations" ADD CONSTRAINT "declarations_evidence_ceremony_id_ceremonies_id_fk" FOREIGN KEY ("evidence_ceremony_id") REFERENCES "public"."ceremonies"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "declarations_pole_uniq" ON "declarations" USING btree ("server_id","pole_key");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "declarations_faction_uniq" ON "declarations" USING btree ("owner_faction_id") WHERE "declarations"."owner_faction_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "declarations_player_uniq" ON "declarations" USING btree ("server_id","owner_dayz_id") WHERE "declarations"."owner_dayz_id" IS NOT NULL;
--> statement-breakpoint
-- grace_until with a default so existing rows get one; the runbook re-stamps it to launch + 7 d.
ALTER TABLE "poles" ADD COLUMN "grace_until" timestamp with time zone NOT NULL DEFAULT (now() + interval '7 days');
--> statement-breakpoint
ALTER TABLE "poles" ALTER COLUMN "grace_until" DROP DEFAULT;
--> statement-breakpoint
-- Move every holding faction's pole into declarations, citing its ceremony.
INSERT INTO "declarations" ("server_id","pole_key","x","y","z","owner_faction_id","evidence_ceremony_id","declared_at")
SELECT f."server_id", f."pole_key", f."x", f."y", f."z", f."id", f."ceremony_id", COALESCE(f."activated_at", f."created_at")
FROM "factions" f
WHERE f."status" IN ('reserved','active','dormant') AND f."ceremony_id" IS NOT NULL;
--> statement-breakpoint
-- ⚠️ Refuse to drop a pole nobody moved. A holding faction without a ceremony_id is a
--    backfilled row this migration cannot cite evidence for; it must be handled by hand
--    (see docs/deploy/2026-09-xx-declarations.md) before this runs. factions_live holds none.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM "factions" WHERE "status" IN ('reserved','active','dormant') AND "ceremony_id" IS NULL) THEN
    RAISE EXCEPTION 'declarations: a holding faction has no ceremony_id; move its pole by hand first';
  END IF;
END $$;
--> statement-breakpoint
DROP INDEX IF EXISTS "factions_holding_pole_uniq";--> statement-breakpoint
ALTER TABLE "factions" DROP COLUMN IF EXISTS "pole_key";--> statement-breakpoint
ALTER TABLE "factions" DROP COLUMN IF EXISTS "x";--> statement-breakpoint
ALTER TABLE "factions" DROP COLUMN IF EXISTS "y";--> statement-breakpoint
ALTER TABLE "factions" DROP COLUMN IF EXISTS "z";
