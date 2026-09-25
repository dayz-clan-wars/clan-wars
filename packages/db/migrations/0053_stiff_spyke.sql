CREATE TABLE IF NOT EXISTS "show_episodes" (
	"week_start" timestamp with time zone PRIMARY KEY NOT NULL,
	"season_id" bigint NOT NULL,
	"season_number" integer NOT NULL,
	"episode_number" integer NOT NULL,
	"stage" text DEFAULT 'new' NOT NULL,
	"context" jsonb,
	"narrative" text,
	"storylines" jsonb,
	"title" text,
	"screening_report" jsonb,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"youtube_video_id" text,
	"draft_message_id" text,
	"approved_by_discord_id" text,
	"approved_at" timestamp with time zone,
	"rejected_by_discord_id" text,
	"rejected_at" timestamp with time zone,
	"youtube_public_at" timestamp with time zone,
	"forum_thread_id" text,
	"discord_posted_at" timestamp with time zone,
	"facebook_video_id" text,
	"facebook_posted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "show_episodes_stage_valid" CHECK ("show_episodes"."stage" IN ('new','context','scripted','voiced','rendered','uploaded','awaiting_approval','approved','public','posted','done','held','rejected')),
	CONSTRAINT "show_episodes_episode_positive" CHECK ("show_episodes"."episode_number" >= 1),
	CONSTRAINT "show_episodes_narrative_after_script" CHECK ("show_episodes"."stage" IN ('new','context','held') OR "show_episodes"."narrative" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "show_pronunciations" (
	"text" text PRIMARY KEY NOT NULL,
	"spoken" text NOT NULL,
	"source" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "show_pronunciations_source_valid" CHECK ("show_pronunciations"."source" IN ('override','llm','fallback'))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "show_text_screening" (
	"text_sha256" text PRIMARY KEY NOT NULL,
	"text" text NOT NULL,
	"verdict" text NOT NULL,
	"source" text NOT NULL,
	"reason" text,
	"decided_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "show_text_screening_verdict_valid" CHECK ("show_text_screening"."verdict" IN ('allow','block')),
	CONSTRAINT "show_text_screening_source_valid" CHECK ("show_text_screening"."source" IN ('blocklist','llm','operator')),
	CONSTRAINT "show_text_screening_sha_shape" CHECK ("show_text_screening"."text_sha256" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "show_episodes" ADD CONSTRAINT "show_episodes_season_id_seasons_id_fk" FOREIGN KEY ("season_id") REFERENCES "public"."seasons"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "show_episodes_season_episode_uniq" ON "show_episodes" USING btree ("season_id","episode_number");