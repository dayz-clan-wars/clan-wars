ALTER TABLE "challenge_attempts" DROP CONSTRAINT "challenge_attempts_challenge_id_verification_challenges_id_fk";
--> statement-breakpoint
DROP INDEX IF EXISTS "verification_challenges_live_idx";--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "challenge_attempts" ADD CONSTRAINT "challenge_attempts_challenge_id_verification_challenges_id_fk" FOREIGN KEY ("challenge_id") REFERENCES "public"."verification_challenges"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "verification_challenges_live_idx" ON "verification_challenges" USING btree ("expires_at") WHERE "verification_challenges"."completed_at" IS NULL AND "verification_challenges"."canceled_at" IS NULL;--> statement-breakpoint
ALTER TABLE "verification_challenges" ADD CONSTRAINT "verification_challenges_bound_requires_complete" CHECK ("verification_challenges"."bound_dayz_id" IS NULL OR "verification_challenges"."completed_at" IS NOT NULL);--> statement-breakpoint
ALTER TABLE "verification_challenges" ADD CONSTRAINT "verification_challenges_notified_requires_complete" CHECK ("verification_challenges"."notified_at" IS NULL OR "verification_challenges"."completed_at" IS NOT NULL);--> statement-breakpoint
ALTER TABLE "verification_challenges" ADD CONSTRAINT "verification_challenges_single_outcome" CHECK (NOT ("verification_challenges"."completed_at" IS NOT NULL AND "verification_challenges"."canceled_at" IS NOT NULL));