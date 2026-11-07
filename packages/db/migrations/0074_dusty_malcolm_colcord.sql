CREATE TABLE IF NOT EXISTS "identity_link_ends" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"dayz_id" text NOT NULL,
	"discord_id" text NOT NULL,
	"ended_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "bans" ADD COLUMN "nitrado_added" text[];--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "identity_link_ends_dayz_idx" ON "identity_link_ends" USING btree ("dayz_id","ended_at");
--> statement-breakpoint
CREATE OR REPLACE FUNCTION identity_link_ends_record() RETURNS trigger AS $$
BEGIN
  INSERT INTO identity_link_ends (dayz_id, discord_id) VALUES (OLD.dayz_id, OLD.discord_id);
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER identity_link_ends_record AFTER DELETE ON identity_links
  FOR EACH ROW EXECUTE FUNCTION identity_link_ends_record();
