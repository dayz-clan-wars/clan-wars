CREATE TABLE IF NOT EXISTS "players" (
	"dayz_id" text PRIMARY KEY NOT NULL,
	"gamertag" text NOT NULL,
	"first_seen_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
DROP INDEX IF EXISTS "verification_challenges_open_sequence_uniq";--> statement-breakpoint
ALTER TABLE "verification_challenges" ADD COLUMN "target_dayz_id" text NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "players_last_seen_idx" ON "players" USING btree ("last_seen_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "verification_challenges_open_target_uniq" ON "verification_challenges" USING btree ("target_dayz_id") WHERE "verification_challenges"."completed_at" IS NULL AND "verification_challenges"."canceled_at" IS NULL;