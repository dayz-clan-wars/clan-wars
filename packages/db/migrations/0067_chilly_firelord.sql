ALTER TABLE "vault_locks" DROP CONSTRAINT "vault_locks_code_digits";--> statement-breakpoint
ALTER TABLE "vault_locks" ALTER COLUMN "code" SET DATA TYPE varchar(6);--> statement-breakpoint
ALTER TABLE "vault_locks" ADD CONSTRAINT "vault_locks_code_digits" CHECK ("vault_locks"."code" ~ '^[0-9]{4,6}$');