CREATE TABLE IF NOT EXISTS "achievement_counters" (
	"owner_kind" text NOT NULL,
	"owner_id" text NOT NULL,
	"key" text NOT NULL,
	"value" integer DEFAULT 0 NOT NULL,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "achievement_counters_owner_kind_owner_id_key_pk" PRIMARY KEY("owner_kind","owner_id","key"),
	CONSTRAINT "achievement_counters_no_coordinates" CHECK (NOT ("achievement_counters"."detail" ? 'x' OR "achievement_counters"."detail" ? 'z' OR "achievement_counters"."detail" ? 'poleKey'))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "achievement_progress" (
	"owner_kind" text NOT NULL,
	"owner_id" text NOT NULL,
	"key" text NOT NULL,
	"count" integer NOT NULL,
	"target" integer NOT NULL,
	"computed_at" timestamp with time zone NOT NULL,
	CONSTRAINT "achievement_progress_owner_kind_owner_id_key_pk" PRIMARY KEY("owner_kind","owner_id","key")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "achievement_unlocks" (
	"owner_kind" text NOT NULL,
	"owner_id" text NOT NULL,
	"key" text NOT NULL,
	"earned_at" timestamp with time zone NOT NULL,
	"evidence_id" bigint,
	"evidence" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"noticed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "achievement_unlocks_owner_kind_owner_id_key_pk" PRIMARY KEY("owner_kind","owner_id","key"),
	CONSTRAINT "achievement_unlocks_owner_kind_valid" CHECK ("achievement_unlocks"."owner_kind" IN ('player','clan')),
	CONSTRAINT "achievement_unlocks_no_coordinates" CHECK (NOT ("achievement_unlocks"."evidence" ? 'poleKey' OR "achievement_unlocks"."evidence" ? 'x' OR "achievement_unlocks"."evidence" ? 'y' OR "achievement_unlocks"."evidence" ? 'z'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "achievement_unlocks_key_idx" ON "achievement_unlocks" USING btree ("key","earned_at");