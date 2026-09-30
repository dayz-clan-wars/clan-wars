ALTER TABLE "bounties" ADD COLUMN "award_key" text;--> statement-breakpoint
ALTER TABLE "bounties" ADD COLUMN "award_days" integer;--> statement-breakpoint
ALTER TABLE "bounties" ADD COLUMN "award_grant_id" bigint;--> statement-breakpoint
ALTER TABLE "bounties" ADD COLUMN "award_failure" text;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "bounties" ADD CONSTRAINT "bounties_award_grant_id_award_grants_id_fk" FOREIGN KEY ("award_grant_id") REFERENCES "public"."award_grants"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "bounties_award_owed_idx" ON "bounties" USING btree ("claimed_by_dayz_id") WHERE "bounties"."status" = 'claimed' AND "bounties"."award_key" IS NOT NULL AND "bounties"."award_grant_id" IS NULL AND "bounties"."award_failure" IS NULL;--> statement-breakpoint
ALTER TABLE "bounties" ADD CONSTRAINT "bounties_award_has_days" CHECK (("bounties"."award_key" IS NULL) = ("bounties"."award_days" IS NULL));--> statement-breakpoint
ALTER TABLE "bounties" ADD CONSTRAINT "bounties_award_days_positive" CHECK ("bounties"."award_days" IS NULL OR "bounties"."award_days" > 0);--> statement-breakpoint
ALTER TABLE "bounties" ADD CONSTRAINT "bounties_award_grant_on_claim" CHECK ("bounties"."award_grant_id" IS NULL OR ("bounties"."status" = 'claimed' AND "bounties"."award_key" IS NOT NULL));