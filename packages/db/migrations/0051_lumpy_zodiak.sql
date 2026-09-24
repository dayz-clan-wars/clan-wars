ALTER TABLE "koth_events" DROP CONSTRAINT "koth_events_state_valid";--> statement-breakpoint
DROP INDEX IF EXISTS "koth_events_slot_uq";--> statement-breakpoint
ALTER TABLE "koth_events" ADD COLUMN "award_key" text;--> statement-breakpoint
-- Hand-added: every row before this migration was scheduled, announced and (if
-- scored) awarded with the Plate Carrier. Must precede koth_events_awarded_has_prize.
UPDATE "koth_events" SET "award_key" = 'plate-carrier';--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "koth_events_slot_uq" ON "koth_events" USING btree ("server_id","slot_at") WHERE "koth_events"."state" IN ('scheduled','live','awarded','no_winner','finished');--> statement-breakpoint
ALTER TABLE "koth_events" ADD CONSTRAINT "koth_events_awarded_has_prize" CHECK (("koth_events"."state" <> 'awarded') OR ("koth_events"."award_key" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "koth_events" ADD CONSTRAINT "koth_events_state_valid" CHECK ("koth_events"."state" IN ('scheduled','live','awarded','no_winner','finished','cancelled','failed'));