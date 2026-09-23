CREATE TABLE IF NOT EXISTS "bounties" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"server_id" integer NOT NULL,
	"target_dayz_id" text NOT NULL,
	"reason" text NOT NULL,
	"placed_by_discord_id" text NOT NULL,
	"placed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"online_budget_ms" bigint NOT NULL,
	"deadline_at" timestamp with time zone NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"closed_at" timestamp with time zone,
	"claimed_by_dayz_id" text,
	"claim_event_id" bigint,
	"claimed_at" timestamp with time zone,
	"revoked_by_discord_id" text,
	"placed_announced_at" timestamp with time zone,
	"closed_announced_at" timestamp with time zone,
	CONSTRAINT "bounties_status_valid" CHECK ("bounties"."status" IN ('open','claimed','expired','revoked')),
	CONSTRAINT "bounties_closed_iff_not_open" CHECK (("bounties"."status" = 'open') = ("bounties"."closed_at" IS NULL)),
	CONSTRAINT "bounties_claim_complete" CHECK (("bounties"."status" = 'claimed') = ("bounties"."claimed_by_dayz_id" IS NOT NULL AND "bounties"."claim_event_id" IS NOT NULL AND "bounties"."claimed_at" IS NOT NULL)),
	CONSTRAINT "bounties_revoked_has_admin" CHECK (("bounties"."status" = 'revoked') = ("bounties"."revoked_by_discord_id" IS NOT NULL)),
	CONSTRAINT "bounties_budget_positive" CHECK ("bounties"."online_budget_ms" > 0)
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "bounties" ADD CONSTRAINT "bounties_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "bounties_one_open_uniq" ON "bounties" USING btree ("server_id","target_dayz_id") WHERE "bounties"."status" = 'open';--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "bounties_status_idx" ON "bounties" USING btree ("server_id","status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "bounties_claimer_idx" ON "bounties" USING btree ("server_id","claimed_by_dayz_id","claimed_at") WHERE "bounties"."status" = 'claimed';