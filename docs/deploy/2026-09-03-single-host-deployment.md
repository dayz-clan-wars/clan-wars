# Runbook: single-host deployment on `regime` — 2026-09-03

Spec: `docs/superpowers/specs/2026-09-03-single-host-deployment-design.md`.

This records what actually happened, not what was planned. Every value below was
observed live during the deploy (see the task-9 observations captured for this
runbook); nothing here is inferred or approximated.

## Scope change made during the deploy

`factory.eli5hq.com` was already returning a **502** before the deploy began — its
backend on `127.0.0.1:3100` was not running. The operator confirmed it is a dead
project, so its `sites-enabled` symlink was removed and nginx reloaded.
`sites-available/factory.eli5hq.com` and its Let's Encrypt certificate were left in
place; restoring the site is one `ln -s`.

⚠️ **Left open, not authorised to fix:** `/etc/letsencrypt/renewal/factory.eli5hq.com.conf`
still exists and uses the `nginx` authenticator. With no matching server block, it will
now **fail at renewal**, producing recurring failure noise. `sudo certbot delete
--cert-name factory.eli5hq.com` clears it — this was not run because deleting a
certificate is the irreversible half of the cleanup.

The neighbour baseline for the rest of this deploy is therefore **three** sites, not
four: `dayzonelife.com`, `manicdotes.com`, `regime.fi` — all `200` before, during and
after every step below.

## Baseline HTTP codes (Task 3 Step 1) vs. after

| Site | Before | After |
|---|---|---|
| dayzonelife.com | 200 | 200 |
| factory.eli5hq.com | 502 (dead project) | removed from nginx — not applicable |
| manicdotes.com | 200 | 200 |
| regime.fi | 200 | 200 |

No pre-existing `default_server` was found anywhere in the config (checked with
`nginx -T`).

## Task 3 — `default_server`

- Before: `Host: dayzclanwars.com` → `301 https://dayzonelife.com/` (the leak — an
  unmatched Host header fell through to whichever vhost nginx picked first).
- After: `000` (connection closed with 444). The three neighbour sites unchanged.

## Task 4 — certificate

- `dayzclanwars.com` and `www.dayzclanwars.com` both resolve to `187.77.9.189`, this
  host's egress IP.
- Bootstrap vhost installed. ⚠️ The first curl after the reload returned an empty reply
  (curl exit 52) — this was reload timing, not a config defect. An immediate retest
  served the `bootstrap` response on the local Host header, the apex and `www`. Recorded
  here so the next person does not spend time debugging a non-problem.
- `certbot certonly --nginx --dry-run` → "The dry run was successful."
- Real issuance → "Successfully received certificate",
  `/etc/letsencrypt/live/dayzclanwars.com/`, **expires 2026-12-02**,
  `authenticator = nginx` (matches the other certs on this host), `certbot.timer`
  active.

## Task 5 — database

- Postgres started as `clan-wars-postgres-1`, healthy, `0.0.0.0:5434->5432`.
- `factions_live` created (owner `factions`). `drizzle.__drizzle_migrations` did not
  exist beforehand — correct for a fresh database.
- ⚠️ The guarded migration runner's guards were **proven before use**: it refused
  `.../factions` with "refusing: not factions_live" and refused an unset
  `DATABASE_URL`. Only after both refusals were confirmed was it pointed at production.
- Before this deploy: `drizzle.__drizzle_migrations` did not exist — the migration
  journal itself had never been created, which is what a fresh database looks like,
  not a count of zero applied migrations. After: **20 of 20**, newest `created_at`
  `1788463371578`, 21 tables. The one-off runner was deleted after use; tree clean.

## Task 6 — server registration

- Registration values came from the Nitrado API, not guesswork: service **19831378**
  = `CW-TEST`, `dayzxb`, username `ni11558038_4`, mission `dayzOffline.enoch`
  (= Livonia).
- ⚠️ The clock offset was **measured, not looked up**: the project's own
  `deriveClockOffsetMs` was run over all 34 real ADM files (all 34 had a real mtime,
  satisfying the function's caller obligation). It returned **25200000 ms**,
  independently matching `clock-offsets.ts`'s Livonia entry.
- Exact command run:

  ```
  --name "CW-TEST" --map livonia --service-id 19831378 --offset-ms 25200000
  ```

- Row read back: id 1, livonia, offset 25200000 (7.0h), `active=t`.

## Task 7 — images, containers, vhost

- `uname -m` = `x86_64`, one of the two architectures the web image was verified on.
- Three containers running: `postgres` (healthy), `web` (`127.0.0.1:3020->3000`),
  `ingest-worker`. **No caddy** — the service no longer exists in the compose file.
- Loopback was verified **before** nginx was pointed at it: `/` → 200,
  `/flags/Flag_APA.png` → 200.
- ⚠️ **Important finding, confirmed live:** Next.js serves `/flags/` with its own
  `Cache-Control: public, max-age=0`. nginx's `add_header` *appends* rather than
  replaces, so without `proxy_hide_header Cache-Control` the two headers would combine
  per RFC 9110 and the upstream `max-age=0` would win — silently defeating flag
  caching while the config and a casual `curl` still looked correct. The fix landed in
  commit `fc1ba6a`. End-to-end result: `https://dayzclanwars.com/flags/Flag_APA.png`
  returns **exactly one** `Cache-Control` header, `public, max-age=604800, immutable`.
- Site live: apex → 200; `www` → 301 to `https://dayzclanwars.com/`; plain `http` → 301
  to the same.
- Worker ingesting: 834 raw lines, 216 events, 12 of 34 ADM files processed (mid-backfill,
  budget 15/sweep). Event types seen include `flag.raised` (6), `flag.lowered` (4),
  `flagpole.built` (3). Timestamps sane — oldest 2026-09-01 00:31 UTC, newest
  2026-09-01 23:08 UTC, none in the future.

## Task 8 — bot

- Discord: `bot ready as Clan Wars#3900`; `players projected 382 of 382 events`.
- No `column ... does not exist` errors, no feed-channel warning at startup.
- Restart test: one cgroup tree, one Main PID — the systemd unit enforces the
  single-instance invariant structurally rather than by convention.
- ⚠️ **New hazard found during this deploy:** the plan's originally-proposed safe
  process check, `pgrep -af "filter @factions/bot"`, false-positived — it matched a
  shell command line that merely *contained* the pattern text, not the bot process
  itself. Pattern matching is unreliable in **both** directions on this host: `pkill -f
  "src/main.ts"` over-matches (~15 `dayzonelife.com` services), and a pgrep filter
  string can under-match-turned-over-match by hitting unrelated shell history. The
  dependable checks are now, in order: `systemctl status clan-wars-bot` (authoritative —
  it reads the unit's cgroup) and, as a manual fallback, process cwd
  (`/proc/<pid>/cwd` under `/opt/clan-wars` for this project, `/var/www/dayzonelife.com`
  for the neighbour). CLAUDE.md's `pkill` hazard bullet was corrected for this in the
  same commit as this runbook.
- Neighbours: all 10 `dayzonelife.com` apps still running, listener PIDs unchanged from
  session start, all three neighbour sites still 200.

## Deviations from the plan

- The neighbour count dropped from four sites to three mid-deploy (see "Scope change"
  above) — this was not anticipated by the original plan text, which assumed four.
- The process-survivor check named in the plan (`pgrep -af "filter @factions/bot"`) was
  replaced after it false-positived live; see Task 8 above and the corrected CLAUDE.md
  bullet.

## Known gap, deliberate, accepted in spec §7

⚠️ **`factions_live` has NO BACKUPS.** It now holds real ingested data (216 events from
the worker backfill) and will hold faction state once players act in-game. Nothing in
this deploy or the repository backs it up. This is recorded in
`docs/superpowers/specs/2026-09-03-single-host-deployment-design.md` §7 as an accepted
gap, not an oversight — do not treat its absence as something this runbook missed.
