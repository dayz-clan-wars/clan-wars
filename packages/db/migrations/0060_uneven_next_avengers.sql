CREATE TABLE IF NOT EXISTS "award_transfers" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"award_grant_id" bigint NOT NULL,
	"from_discord_id" text NOT NULL,
	"to_discord_id" text NOT NULL,
	"transferred_at" timestamp with time zone NOT NULL,
	"remaining_ms" bigint NOT NULL
);
--> statement-breakpoint
ALTER TABLE "award_grants" ADD COLUMN "remaining_ms" bigint;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "award_transfers" ADD CONSTRAINT "award_transfers_award_grant_id_award_grants_id_fk" FOREIGN KEY ("award_grant_id") REFERENCES "public"."award_grants"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "award_transfers_grant_idx" ON "award_transfers" USING btree ("award_grant_id");