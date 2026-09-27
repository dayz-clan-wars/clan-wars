CREATE TABLE IF NOT EXISTS "referral_qualifications" (
	"referred_discord_id" text PRIMARY KEY NOT NULL,
	"referrer_discord_id" text NOT NULL,
	"qualified_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "referral_week_winners" (
	"week_start" timestamp with time zone NOT NULL,
	"discord_id" text NOT NULL,
	"dayz_id" text NOT NULL,
	"award_grant_id" bigint NOT NULL,
	CONSTRAINT "referral_week_winners_week_start_discord_id_pk" PRIMARY KEY("week_start","discord_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "referral_weeks" (
	"week_start" timestamp with time zone PRIMARY KEY NOT NULL,
	"closed_at" timestamp with time zone NOT NULL,
	"top_count" integer NOT NULL,
	"announced_at" timestamp with time zone,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "referral_qualifications" ADD CONSTRAINT "referral_qualifications_referred_discord_id_referrals_referred_discord_id_fk" FOREIGN KEY ("referred_discord_id") REFERENCES "public"."referrals"("referred_discord_id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "referral_week_winners" ADD CONSTRAINT "referral_week_winners_week_start_referral_weeks_week_start_fk" FOREIGN KEY ("week_start") REFERENCES "public"."referral_weeks"("week_start") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "referral_week_winners" ADD CONSTRAINT "referral_week_winners_award_grant_id_award_grants_id_fk" FOREIGN KEY ("award_grant_id") REFERENCES "public"."award_grants"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "referral_qualifications_week_idx" ON "referral_qualifications" USING btree ("qualified_at","referrer_discord_id");
--> statement-breakpoint
CREATE OR REPLACE FUNCTION referral_qualifications_permanent() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'referral qualifications are permanent: % refused', lower(TG_OP);
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER referral_qualifications_permanent BEFORE UPDATE OR DELETE ON referral_qualifications
  FOR EACH ROW EXECUTE FUNCTION referral_qualifications_permanent();
--> statement-breakpoint
CREATE TRIGGER referral_qualifications_no_truncate BEFORE TRUNCATE ON referral_qualifications
  FOR EACH STATEMENT EXECUTE FUNCTION referral_qualifications_permanent();