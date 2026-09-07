CREATE TABLE IF NOT EXISTS "faction_vote_ballots" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"vote_id" bigint NOT NULL,
	"dayz_id" text NOT NULL,
	"cast_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "faction_votes" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"faction_id" bigint NOT NULL,
	"server_id" integer NOT NULL,
	"nominee_dayz_id" text NOT NULL,
	"nominee_discord_id" text NOT NULL,
	"opened_by_dayz_id" text NOT NULL,
	"leader_dayz_id" text NOT NULL,
	"leader_discord_id" text NOT NULL,
	"opened_at" timestamp with time zone NOT NULL,
	"closes_at" timestamp with time zone NOT NULL,
	"electorate_dayz_ids" text[] NOT NULL,
	"electorate_size" integer NOT NULL,
	"result" text,
	"closed_at" timestamp with time zone,
	CONSTRAINT "faction_votes_result_valid" CHECK ("faction_votes"."result" IS NULL OR "faction_votes"."result" IN ('passed','failed')),
	CONSTRAINT "faction_votes_closed_iff_result" CHECK (("faction_votes"."closed_at" IS NULL) = ("faction_votes"."result" IS NULL)),
	CONSTRAINT "faction_votes_size_non_negative" CHECK ("faction_votes"."electorate_size" >= 0)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "guest_passes" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"faction_id" bigint NOT NULL,
	"discord_user_id" text NOT NULL,
	"granted_by_discord_id" text NOT NULL,
	"granted_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"converted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "succession_claims" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"faction_id" bigint NOT NULL,
	"server_id" integer NOT NULL,
	"claimant_dayz_id" text NOT NULL,
	"claimant_discord_id" text NOT NULL,
	"leader_dayz_id" text NOT NULL,
	"leader_discord_id" text NOT NULL,
	"opened_at" timestamp with time zone NOT NULL,
	"resolves_at" timestamp with time zone NOT NULL,
	"outcome" text,
	"closed_at" timestamp with time zone,
	CONSTRAINT "succession_claims_outcome_valid" CHECK ("succession_claims"."outcome" IS NULL OR "succession_claims"."outcome" IN ('succeeded','voided')),
	CONSTRAINT "succession_claims_closed_iff_outcome" CHECK (("succession_claims"."closed_at" IS NULL) = ("succession_claims"."outcome" IS NULL))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "vault_history" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"faction_id" bigint NOT NULL,
	"lock_id" bigint,
	"lock_name" text NOT NULL,
	"action" text NOT NULL,
	"dayz_id" text NOT NULL,
	"at" timestamp with time zone NOT NULL,
	CONSTRAINT "vault_history_action_valid" CHECK ("vault_history"."action" IN ('added','edited','rotated','revealed','confirmed','deleted'))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "vault_locks" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"faction_id" bigint NOT NULL,
	"name" text NOT NULL,
	"code" char(4) NOT NULL,
	"note" text,
	"min_role" text NOT NULL,
	"created_by_dayz_id" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"rotated_at" timestamp with time zone,
	"rotated_by_dayz_id" text,
	"confirmed_at" timestamp with time zone,
	"exposed_at" timestamp with time zone,
	CONSTRAINT "vault_locks_min_role_valid" CHECK ("vault_locks"."min_role" IN ('leader','officer','member')),
	CONSTRAINT "vault_locks_code_digits" CHECK ("vault_locks"."code" ~ '^[0-9]{4}$')
);
--> statement-breakpoint
ALTER TABLE "factions" ADD COLUMN "next_vote_allowed_at" timestamp with time zone;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "faction_vote_ballots" ADD CONSTRAINT "faction_vote_ballots_vote_id_faction_votes_id_fk" FOREIGN KEY ("vote_id") REFERENCES "public"."faction_votes"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "faction_votes" ADD CONSTRAINT "faction_votes_faction_id_factions_id_fk" FOREIGN KEY ("faction_id") REFERENCES "public"."factions"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "faction_votes" ADD CONSTRAINT "faction_votes_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "guest_passes" ADD CONSTRAINT "guest_passes_faction_id_factions_id_fk" FOREIGN KEY ("faction_id") REFERENCES "public"."factions"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "succession_claims" ADD CONSTRAINT "succession_claims_faction_id_factions_id_fk" FOREIGN KEY ("faction_id") REFERENCES "public"."factions"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "succession_claims" ADD CONSTRAINT "succession_claims_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "vault_history" ADD CONSTRAINT "vault_history_faction_id_factions_id_fk" FOREIGN KEY ("faction_id") REFERENCES "public"."factions"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "vault_history" ADD CONSTRAINT "vault_history_lock_id_vault_locks_id_fk" FOREIGN KEY ("lock_id") REFERENCES "public"."vault_locks"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "vault_locks" ADD CONSTRAINT "vault_locks_faction_id_factions_id_fk" FOREIGN KEY ("faction_id") REFERENCES "public"."factions"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "faction_vote_ballots_uniq" ON "faction_vote_ballots" USING btree ("vote_id","dayz_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "faction_votes_open_uniq" ON "faction_votes" USING btree ("faction_id") WHERE "faction_votes"."closed_at" IS NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "guest_passes_user_idx" ON "guest_passes" USING btree ("faction_id","discord_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "succession_claims_open_uniq" ON "succession_claims" USING btree ("faction_id") WHERE "succession_claims"."closed_at" IS NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "vault_history_faction_idx" ON "vault_history" USING btree ("faction_id","at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "vault_locks_faction_idx" ON "vault_locks" USING btree ("faction_id");