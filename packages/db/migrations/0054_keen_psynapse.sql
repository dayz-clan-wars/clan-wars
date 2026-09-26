CREATE TABLE IF NOT EXISTS "referrals" (
	"referred_discord_id" text PRIMARY KEY NOT NULL,
	"referrer_discord_id" text NOT NULL,
	"referrer_dayz_id" text NOT NULL,
	"source" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"referrer_notified_at" timestamp with time zone,
	CONSTRAINT "referrals_not_self" CHECK ("referrals"."referred_discord_id" <> "referrals"."referrer_discord_id"),
	CONSTRAINT "referrals_source_valid" CHECK ("referrals"."source" IN ('link_bot','link_site','later_bot','later_site'))
);
--> statement-breakpoint
ALTER TABLE "verification_challenges" ADD COLUMN "referrer_discord_id" text;--> statement-breakpoint
ALTER TABLE "verification_challenges" ADD COLUMN "referral_refused" text;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "referrals_referrer_idx" ON "referrals" USING btree ("referrer_discord_id");
--> statement-breakpoint
CREATE OR REPLACE FUNCTION referrals_permanent() RETURNS trigger AS $$
BEGIN
  IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
    RAISE EXCEPTION 'referrals are permanent: % refused', lower(TG_OP);
  END IF;
  IF NEW.referred_discord_id IS DISTINCT FROM OLD.referred_discord_id
     OR NEW.referrer_discord_id IS DISTINCT FROM OLD.referrer_discord_id
     OR NEW.referrer_dayz_id IS DISTINCT FROM OLD.referrer_dayz_id
     OR NEW.source IS DISTINCT FROM OLD.source
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR (OLD.referrer_notified_at IS NOT NULL AND NEW.referrer_notified_at IS DISTINCT FROM OLD.referrer_notified_at) THEN
    RAISE EXCEPTION 'referrals are permanent: update refused';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER referrals_permanent BEFORE UPDATE OR DELETE ON referrals
  FOR EACH ROW EXECUTE FUNCTION referrals_permanent();
--> statement-breakpoint
CREATE TRIGGER referrals_no_truncate BEFORE TRUNCATE ON referrals
  FOR EACH STATEMENT EXECUTE FUNCTION referrals_permanent();