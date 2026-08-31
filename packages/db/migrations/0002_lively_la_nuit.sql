CREATE TABLE IF NOT EXISTS "challenge_attempts" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"challenge_id" bigint NOT NULL,
	"dayz_id" text NOT NULL,
	"progress_index" integer DEFAULT 0 NOT NULL,
	"last_matched_event_id" bigint DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "identity_links" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"discord_id" text NOT NULL,
	"dayz_id" text NOT NULL,
	"gamertag" text NOT NULL,
	"verified_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "verification_challenges" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"discord_id" text NOT NULL,
	"guild_id" text NOT NULL,
	"channel_id" text NOT NULL,
	"sequence" text[] NOT NULL,
	"issued_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"completed_at" timestamp with time zone,
	"canceled_at" timestamp with time zone,
	"bound_dayz_id" text,
	"notified_at" timestamp with time zone
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "challenge_attempts" ADD CONSTRAINT "challenge_attempts_challenge_id_verification_challenges_id_fk" FOREIGN KEY ("challenge_id") REFERENCES "public"."verification_challenges"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "challenge_attempts_challenge_dayz_uniq" ON "challenge_attempts" USING btree ("challenge_id","dayz_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "identity_links_discord_uniq" ON "identity_links" USING btree ("discord_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "identity_links_dayz_uniq" ON "identity_links" USING btree ("dayz_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "verification_challenges_discord_idx" ON "verification_challenges" USING btree ("discord_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "verification_challenges_live_idx" ON "verification_challenges" USING btree ("expires_at");