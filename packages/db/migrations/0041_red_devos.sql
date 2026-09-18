CREATE TABLE IF NOT EXISTS "notice_read_marks" (
	"discord_id" text PRIMARY KEY NOT NULL,
	"through_id" bigint NOT NULL,
	"marked_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "notice_reads" (
	"discord_id" text NOT NULL,
	"notice_id" bigint NOT NULL,
	"read_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notice_reads_discord_id_notice_id_pk" PRIMARY KEY("discord_id","notice_id")
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "notice_reads" ADD CONSTRAINT "notice_reads_notice_id_clan_notices_id_fk" FOREIGN KEY ("notice_id") REFERENCES "public"."clan_notices"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
