# Acceptance — targeted identity linking

**Date:** 2026-09-01
**Plan:** `docs/superpowers/plans/2026-09-01-targeted-identity-linking.md`
**Spec:** `docs/superpowers/specs/2026-09-01-targeted-identity-linking-design.md`
**Environment:** CW-TEST, live Nitrado ingest, `factions_live`

Unlike every previous plan in this repo, this one was staged for real against live
data rather than reasoned about. The values below were observed, not constructed.

## What prompted the work

A real `/link` in production issued this challenge:

    id 1  sequence {EmoteSOS, EmoteRPSRandom, EmoteGreeting, EmoteCome}
          issued 2026-09-01 15:48:41Z   expired 15:58:41Z   never completed

Four emotes, led by `EmoteSOS` — a token that appears in real ADM lines but that a
player cannot find on the in-game emote wheel. The player could not complete it. The
challenge also named nobody, so any character performing the sequence would have won it.

## Deploy

Per `docs/deploy/2026-09-01-targeted-linking.md`, before migrating:

| | before | after |
|---|---|---|
| `verification_challenges` | 1 | 0 |
| `challenge_attempts` | 0 | 0 |
| `identity_links` | 0 | 0 (untouched) |

The one deleted row is the unwinnable challenge above. Migration `0012` then applied
cleanly: `players` created (`players_pkey`, `players_last_seen_idx`);
`verification_challenges_open_target_uniq` added;
`verification_challenges_open_sequence_uniq` **gone**, as designed.

## The projection

On bot restart: `players projected 31 of 31 events`.

| dayz_id | gamertag | first_seen_at | last_seen_at |
|---|---|---|---|
| 89B90470…1CE2A71 | RonaldRaygun552 | 2026-09-01 00:31:51Z | 2026-09-01 17:31:33Z |
| 40A7D671…18B61AB5 | Nortrax9713 | 2026-09-01 04:02:21Z | 2026-09-01 04:02:21Z |

## The link, end to end

`/link` offered both gamertags in its autocomplete. RonaldRaygun552 was chosen, and the
challenge issued was:

    id 4   target_dayz_id 89B90470B5F5E8C64EF8B28C89250D6AD1CE2A71
           sequence {EmoteThumbDown, EmotePointSelf, EmoteSurrender}
           issued  2026-09-01 17:55:58Z
           expires 2026-09-02 17:55:58Z

Three emotes, all selectable from the wheel; the tester read them off the reply as
"thumbs down, point at self, surrender" and performed them in game in that order.

    completed_at 2026-09-01 18:05:13.499Z
    notified_at  2026-09-01 18:05:15.063Z      (DM 1.6s after completion)
    bound_dayz_id 89B90470B5F5E8C64EF8B28C89250D6AD1CE2A71

    identity_links: discord 481653901960151050 -> 89B90470…1CE2A71
                    gamertag RonaldRaygun552, verified 18:05:13.499Z

Elapsed 17:55:58Z → 18:05:13Z, about 9m15s, dominated by Nitrado's 5–10 minute ADM
publication lag rather than anything in this system. `challenge_attempts` holds 1 row —
the tester spent no wasted emotes.

## The security property, against live data

    target_dayz_id = bound_dayz_id   ->   true

The challenge named its character at issue time and only that character could advance
it. This is the property the whole design rests on: it is what makes three emotes
sufficient and what allowed the open-sequence unique index to be retired.

## The nickname

**Not renamed, and correctly so.** The DM read:

> Verified — your Discord account is now linked to your character. Your nickname could
> not be changed: Discord will not let a bot rename the server owner.

The tester owns the guild, and Discord refuses owner renames permanently — one of the
two permanent refusals in spec §6. The link committed first and was never at risk,
which is the ordering the design requires.

## Not exercised

- **The successful rename path.** Only the `is-owner` refusal was observed live. The
  `outranked` and `no-permission` refusals and the `ok` path are unit-tested only, and
  need a non-owner account to confirm in production.
- **`/unlink` clearing a nickname.** Untested live for the same reason.
- **A wrong-character switch** (cancel-and-reissue) and **budget exhaustion**.
- **The autocomplete's 25-choice cap**, since only two characters exist on CW-TEST.

## Defects found while staging

1. **`runPlayerProjection` was never called.** Built and tested, but no production
   caller, so `players` stayed empty and `/link` could not work at all. Fixed in
   `3664124` by running it first in the bot's tick loop.
2. **Migrating ahead of the running process.** `factions_live` was migrated while the
   bot still ran pre-migration code, so `handleLink` inserted a null `target_dayz_id`
   against a NOT NULL column and Discord showed "The application did not respond" twice.
   No data damage; both inserts rolled back. The correct order is stop -> migrate ->
   start: both old-code-on-new-schema and new-code-on-old-schema break, so the
   migration is a downtime window rather than a rolling restart.
3. **A duplicate completion DM**, caused by two bot processes surviving a `pkill` whose
   pattern missed the expanded tsx command line. Not a code defect, but it exposed a
   real constraint now recorded as inbox item 22: `notifyCompleted` sends before it
   marks, so the notifier is at-least-once across processes.
