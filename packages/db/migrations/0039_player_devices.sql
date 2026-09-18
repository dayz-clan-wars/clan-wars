CREATE TABLE IF NOT EXISTS "player_devices" (
	"dayz_id" text NOT NULL,
	"device" text NOT NULL,
	"gamertag" text NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "player_devices_dayz_id_device_pk" PRIMARY KEY("dayz_id","device")
);
--> statement-breakpoint
ALTER TABLE "bans" ADD COLUMN "reason" text DEFAULT 'zone' NOT NULL;