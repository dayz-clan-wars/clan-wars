ALTER TABLE "airdrop_events" ALTER COLUMN "colour" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "airdrop_events" ADD COLUMN "kind" text;--> statement-breakpoint
ALTER TABLE "airdrop_events" ADD CONSTRAINT "airdrop_events_kind_valid" CHECK ("airdrop_events"."kind" IN ('boom','guns'));--> statement-breakpoint
ALTER TABLE "airdrop_events" ADD CONSTRAINT "airdrop_events_colour_xor_kind" CHECK (("airdrop_events"."colour" IS NULL) <> ("airdrop_events"."kind" IS NULL));