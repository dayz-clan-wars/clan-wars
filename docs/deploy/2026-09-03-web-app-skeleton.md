# Deploy: the web app skeleton — 2026-09-03

**Shipping:** `apps/web`, a Next.js app serving one static page and the 33 flag images at
`dayzclanwars.com`, plus `FLAG_IMAGE_BASE_URL` in the bot filling `feed-embed.ts`'s
existing resolver hook. Design: `docs/superpowers/specs/2026-09-03-web-app-skeleton-design.md`.

**No migration.** This deploy touches no schema and no database. It adds a Docker image,
two compose services (`web`, `caddy`), and one bot env var.

⚠️ Follow CLAUDE.md's rules throughout: port 5434 only, never touch `factions_live`
outside a deliberate step, and confirm zero surviving bot processes before starting one.
This runbook targets the **VPS**, a separate machine from the one running Postgres, the
bot and the ingest worker — `factions_live` is not reachable from it and this deploy does
not change that.

---

## Order of operations

### 1. Prerequisites the deploy cannot satisfy for itself

- A DNS **A record** for `dayzclanwars.com`, and one for `www.dayzclanwars.com`, pointing
  at the VPS, propagated before Caddy starts. Verify from outside the VPS:

  ```bash
  dig +short dayzclanwars.com
  dig +short www.dayzclanwars.com
  ```

  Caddy's ACME challenge fails without this, and it will retry against Let's Encrypt's
  rate limits — starting Caddy before DNS resolves is not free.

- Ports **80 and 443** reachable from the internet. ⚠️ Port 80 is not optional: it
  carries the ACME HTTP-01 challenge Caddy uses to obtain the certificate. Blocking it
  to "just serve 443" breaks TLS issuance entirely.

### 2. Get the code onto the VPS and build the image

Pull or copy this branch/commit to the VPS, then:

```bash
docker compose build web
```

The image is a multi-stage build (`apps/web/Dockerfile`): a builder that installs the
workspace and runs `next build`, and a slim runtime carrying only Next's `standalone`
output plus `public/` (the flag images included). It has been built and verified on
**both linux/arm64** (native `docker compose build web` on the dev machine) **and
linux/amd64** (`docker build --platform linux/amd64`, under QEMU emulation) on
2026-09-03. Both resolved and installed the correct platform-specific `sharp` binary from
the lockfile (`@img/sharp-linuxmusl-arm64` / `-x64`) — neither architecture depends on an
untested guess. If the VPS is some third architecture, rebuild and re-check before
trusting this image there.

### 3. Start only the web services

```bash
docker compose up -d web caddy
```

Compose interpolates the whole file regardless of which services you named, so this
prints a `NITRADO_TOKEN is not set` warning. That's expected and harmless here — it comes
from the `ingest-worker` service definition, which this command is not starting.

⚠️ **Never a bare `docker compose up -d` on the VPS.** `docker-compose.yml` also
describes `postgres` and `ingest-worker` — a bare `up -d` there stands up a second,
**empty** Postgres that looks like a working database and holds none of the live data.
Always name the services.

⚠️ **Never `docker compose down` on the VPS**, here or later. In older Compose that
ignores the services you named and tears down the whole project — including containers
this runbook never started. Use `docker compose stop <service>` (see Rollback, below).

### 4. Verify TLS and the images, from outside the VPS

```bash
curl -sI https://dayzclanwars.com/ | head -1
# expect: HTTP/2 200

curl -sI https://dayzclanwars.com/flags/Flag_Wolf.png | grep -i content-type
# expect: content-type: image/png

curl -sI https://dayzclanwars.com/flags/Flag_Sakhal.png | head -1
# expect: HTTP/2 200
```

`Flag_Sakhal` is checked explicitly because it's the one texture whose wiki source file
did not follow the `<texture>.png` naming rule (`Sakhal_flag.PNG`) — the fetch script's
alias table absorbed that at fetch time, so the served file is still `Flag_Sakhal.png`
like every other, but it's the one name most likely to silently break if that mapping is
ever "simplified."

Steps 1–4 are fully verifiable without touching the bot at all.

### 5. Turn on thumbnails

Add to the bot's `.env`:

```
FLAG_IMAGE_BASE_URL=https://dayzclanwars.com
```

⚠️ In `.env`, not only on the start command line — same reason `BOT_FEED_CHANNEL_ID` and
every other `BOT_*`/feature env var live there: a command-line-only variable turns the
feature off at the next restart with nothing saying so. A trailing slash is tolerated
(the loader strips it); a path, query string, fragment, or embedded credentials is
rejected at load, not silently accepted.

### 6. Restart the bot as a single instance

Confirm zero surviving bot processes:

```bash
ps ax | grep "src/main.ts" | grep -v grep
```

Expect no output. If something is running, `pkill -f "src/main.ts"` and re-check —
CLAUDE.md's `notifyCompleted`-DMs-before-it-marks rule makes a second live instance a
player-visible bug, not just a data race.

Start exactly one instance with the env sourced:

```bash
set -a && . ./.env && set +a && nohup pnpm --filter @factions/bot start > bot.log 2>&1 &
```

(`. ./.env`, not `. .env` — zsh's `.` searches `$PATH` for a slashless name and silently
starts nothing.)

### 7. Acceptance

⚠️ Be honest about its cost, carried over from the design's §9. Steps 1–4 above are fully
verifiable without touching the bot. Confirming a thumbnail actually renders in a real
embed is not — there are only two honest ways to get one:

- **Wait for the next real transition.** Costs nothing, but the timing is not ours — the
  live server currently holds one active faction and may not transition for days.
- **Re-queue a backfilled row** (`update faction_events set posted_at = null where id = 2`)
  and let the next tick repost it. ⚠️ This posts a **duplicate embed into a public channel
  real players can see**. It's recoverable (delete the message afterward) but it is a
  deliberate blemish on the record — a choice to make out loud, not a routine verification
  step.

Neither is required to consider the deploy itself successful.

### 8. Rollback

```bash
docker compose stop web caddy
```

Leaves the bot, Postgres and the ingest worker untouched. Unsetting
`FLAG_IMAGE_BASE_URL` in `.env` and restarting the bot (same zero-survivor check as step
6) returns embeds to their current thumbnail-less state. Neither step requires a schema
change — there is none to revert.

---

## What is NOT part of this deploy

- No Discord OAuth, sessions, or any authentication.
- No database access from the web app — `factions_live` stays on the machine running the
  bot and worker, not the VPS. Every open question in
  `docs/direction/2026-09-02-web-app-and-faction-map.md` stays open.
- No faction map, roster page, public directory, or API.
- No CI.
- No alerting on a blocked feed queue — unrelated to this deploy; still open, see inbox
  item 35.
