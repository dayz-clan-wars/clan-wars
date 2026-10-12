# Carry bases through the wipe — deploy and Livonia cleanup

Spec: `docs/superpowers/specs/2026-10-12-carry-bases-through-wipe-design.md`.

## 1. Deploy

The release carries migration 0065 (`declarations.carried_since`, nullable,
additive). `deploy-release.sh` applies it with the bot stopped. Nothing else.

## 2. Clear the Livonia bases (once, after the deploy)

On the host, in `/opt/clan-wars`, with `DATABASE_URL` from `.env`:

    pnpm clear-bases --server 1 --before 2026-10-08T00:00:00Z --dry-run

Expect exactly the Livonia-era bases (2026-10-12: SKULL, ADM, VOLK, Z2,
WOOKI, all declared in September). Anything declared on or after
2026-10-08 in that list means the cutoff is wrong: stop.

Then the same command without `--dry-run`. The bot can keep running: every
writer takes the same declarations lock.

## 3. Check

    select count(*) from declarations where declared_at < '2026-10-08';  -- 0

Within one ingest sweep `faction-supplies.json` re-uploads without those
clans (`supply_uploads.uploaded_at` moves). Tell VOLK their 2026-10-12 raise
was before the cleanup: one full member raises a white flag again.

## Rollback

The release: the column is nullable and unread by older code. The cleanup
is not reversible except from the deploy's pre-migration dump; the bases it
removes point at nothing on Chernarus.
