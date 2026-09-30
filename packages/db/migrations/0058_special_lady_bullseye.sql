-- Hand-edited after generation: drizzle-kit emits a bare ADD COLUMN ... NOT NULL, which
-- fails on any database holding a grant. Every grant before this migration is a
-- plate-carrier (the only key awards.json has ever had), whose durationDays is 7.
ALTER TABLE "award_grants" ADD COLUMN "duration_days" integer;--> statement-breakpoint
UPDATE "award_grants" SET "duration_days" = 7;--> statement-breakpoint
ALTER TABLE "award_grants" ALTER COLUMN "duration_days" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "award_grants" ADD CONSTRAINT "award_grants_duration_positive" CHECK ("award_grants"."duration_days" > 0);
