# Single-Host Deployment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run Postgres, the ingest worker, the web app and the bot on `regime` — the machine already serving four production vhosts behind a system nginx — without disturbing any of them.

**Architecture:** Caddy is deleted from the repository; the system nginx terminates TLS for `dayzclanwars.com` and proxies to the web container published on `127.0.0.1:3020`. Postgres and the ingest worker run under the existing compose file. The bot runs as a systemd unit, which is what makes its single-instance invariant enforceable on a host where ~15 unrelated processes match `pkill -f "src/main.ts"`.

**Tech Stack:** nginx 1.24.0 (system, Ubuntu), certbot with the `nginx` authenticator, Docker Compose, systemd, pnpm 9.12.0 workspace, Node 22.23.2, drizzle-orm over postgres.js.

**Spec:** `docs/superpowers/specs/2026-09-03-single-host-deployment-design.md`

## Global Constraints

- **Postgres is on host port 5434 only.** 5432 and 5433 belong to other projects on this machine. Never stop, remove, or repoint their containers.
- **`factions_live` is the production database**, on the same Postgres as `factions`. `factions` is written by tests. They must never be the same URL.
- **Never run a bare `docker compose up -d`.** Always name services.
- **⚠️ Never run `pkill -f "src/main.ts"` on this host.** It matches ~15 `dayzonelife.com` services (verifier, api, ingest-worker, projector, granter, rebooter, enforcer, crier, newsdesk, notifier and more). Use `systemctl stop clan-wars-bot`.
- **Every nginx reload is a reload of the server for four other production sites.** Run `sudo nginx -t` before every one, and use `reload`, never `restart`.
- **The full gate, always with `--force`:**
  `TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions" npx turbo run typecheck test --concurrency=1 --force`
  Expect **22/22 tasks**. Check the count, not the exit code.
- Repo root: `/opt/clan-wars`. Host user: `acab`. `pnpm` is at `/home/acab/.local/bin/pnpm`; `node` at `/usr/bin/node` (v22.23.2).
- Web container publishes **`127.0.0.1:3020:3000`** — loopback only, never `0.0.0.0`.
- Migration journal has **20** entries (`0000`–`0019`).

---

## File Structure

| File | Responsibility |
|---|---|
| `docker-compose.yml` (modify) | Remove `caddy` service + its two volumes; publish `web` on loopback 3020 |
| `Caddyfile` (delete) | Superseded by the nginx vhost |
| `deploy/nginx/dayzclanwars.com.conf` (create) | The production vhost, version controlled |
| `deploy/nginx/00-default-server.conf` (create) | Catch-all for unmatched `Host`, closing a cross-site leak |
| `deploy/systemd/clan-wars-bot.service` (create) | Bot supervision; the single-instance guarantee |
| `deploy/README.md` (create) | What is in `deploy/` and how it is installed |
| `apps/web/test/deployment-config.test.ts` (create) | Drift guard: compose must have no `caddy` and must publish loopback-only |
| `apps/web/test/smoke.test.ts` (modify) | Its docblock states a fact about a VPS that does not exist |
| `CLAUDE.md` (modify) | Four false statements; see spec §1 |
| `docs/deploy/2026-09-03-single-host-deployment.md` (create) | The runbook recording what was actually done |

---

## Task 1: Remove Caddy from the repository

**Files:**
- Modify: `docker-compose.yml`
- Delete: `Caddyfile`
- Create: `apps/web/test/deployment-config.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `web` reachable at `127.0.0.1:3020` once started; no `caddy` service exists to be started by accident.

- [ ] **Step 1: Write the failing test**

Create `apps/web/test/deployment-config.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const COMPOSE = readFileSync(
  join(import.meta.dirname, "..", "..", "..", "docker-compose.yml"),
  "utf8",
);

/**
 * ⚠️ nginx owns :80 and :443 on the host this stack is deployed to, and serves
 * four other production sites from them. A `caddy` service in this file is a
 * request for a port that is permanently taken: the failure is a container in
 * a restart loop and a site that looks deployed.
 *
 * The compose file and the deployment topology are two statements of one fact.
 * Nothing but this test holds them together — `docker compose config` will
 * happily validate a Caddy that can never bind.
 */
describe("compose matches the single-host deployment", () => {
  it("declares no caddy service", () => {
    expect(COMPOSE).not.toMatch(/^\s{2}caddy:/m);
  });

  it("declares no caddy volumes", () => {
    expect(COMPOSE).not.toContain("caddy-data");
    expect(COMPOSE).not.toContain("caddy-config");
  });

  /**
   * ⚠️ Loopback, not 0.0.0.0. Publishing all interfaces would serve the site
   * over plain HTTP on :3020 alongside the TLS one nginx terminates — the
   * exact hazard the original "no ports mapping" comment was guarding.
   */
  it("publishes web on loopback only", () => {
    expect(COMPOSE).toContain('"127.0.0.1:3020:3000"');
    expect(COMPOSE).not.toMatch(/"0\.0\.0\.0:\d+:3000"/);
    expect(COMPOSE).not.toMatch(/"\d+:3000"/);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
cd /opt/clan-wars && npx vitest run --root apps/web test/deployment-config.test.ts
```

Expected: FAIL — three failures, because `caddy:` is still present and `web` publishes no port.

- [ ] **Step 3: Edit `docker-compose.yml`**

Delete the entire `caddy:` service block, the `caddy-data:` and `caddy-config:` volume entries, and the comment block beginning "⚠️ This file also describes `postgres` and `ingest-worker`, which must NOT be started on the VPS" (it names a machine that does not exist).

Replace the `web` service's `# ⚠️ No ports mapping...` comment and add the publish:

```yaml
  web:
    build: { context: ., dockerfile: apps/web/Dockerfile }
    restart: unless-stopped
    environment:
      NODE_ENV: production
    # ⚠️ Loopback only. The system nginx terminates TLS for dayzclanwars.com
    # and proxies here; publishing 0.0.0.0 would serve the same site over
    # plain HTTP on :3020 alongside the TLS one.
    # 3020 is deliberately outside the 3000-3011 band the other projects on
    # this host occupy (dayzonelife.com :3010, factory.eli5hq.com :3100).
    ports: ["127.0.0.1:3020:3000"]
```

Add this comment at the top of the `services:` block, replacing the deleted VPS one:

```yaml
# ⚠️ Never `docker compose up -d` bare on this host. Name the services. There
# is no second machine: postgres, ingest-worker and web all run here, and the
# bot runs beside them under systemd (deploy/systemd/clan-wars-bot.service).
```

- [ ] **Step 4: Delete the Caddyfile**

```bash
cd /opt/clan-wars && git rm Caddyfile
```

- [ ] **Step 5: Run the test to verify it passes**

```bash
cd /opt/clan-wars && npx vitest run --root apps/web test/deployment-config.test.ts
```

Expected: PASS, 3 tests.

- [ ] **Step 6: Verify compose still parses**

```bash
cd /opt/clan-wars && sudo docker compose config --services
```

Expected exactly three lines: `postgres`, `ingest-worker`, `web`. If `caddy` appears, Step 3 missed a block.

- [ ] **Step 7: Commit**

```bash
cd /opt/clan-wars
git add docker-compose.yml apps/web/test/deployment-config.test.ts
git commit -m "feat(deploy): remove Caddy, publish web on loopback 3020

nginx owns :80/:443 on the deployment host and serves four other production
sites from them, so Caddy cannot bind there. A caddy service left in the file
is a request for a permanently taken port. deployment-config.test.ts holds the
compose file and the topology together."
```

---

## Task 2: Version-control the nginx vhosts and the systemd unit

**Files:**
- Create: `deploy/nginx/00-default-server.conf`
- Create: `deploy/nginx/dayzclanwars.com.conf`
- Create: `deploy/systemd/clan-wars-bot.service`
- Create: `deploy/README.md`

**Interfaces:**
- Consumes: `web` on `127.0.0.1:3020` (Task 1).
- Produces: files installed by symlink in Tasks 3, 7 and 8. The vhost expects the cert at `/etc/letsencrypt/live/dayzclanwars.com/`.

Nothing is installed in this task — these are files in the repo only. ⚠️ A vhost whose only copy lives in `/etc/nginx` is a configuration stored on the machine it configures.

- [ ] **Step 1: Create `deploy/nginx/00-default-server.conf`**

```nginx
# Catch-all for requests whose Host matches no vhost.
#
# ⚠️ Without this, nginx serves an unmatched Host from whichever server block
# loaded first — alphabetically, dayzonelife.com. Before this file existed, a
# request for dayzclanwars.com returned a 301 to dayzonelife.com: a leak
# between unrelated properties caused purely by file load order.
#
# 444 closes the connection with no response. It is the right answer to a
# request for a name this server does not serve.
#
# Named 00- so it loads before every sites-enabled vhost.
server {
    listen 80 default_server;
    listen [::]:80 default_server;
    server_name _;
    return 444;
}
```

⚠️ Deliberately no `:443 default_server`. Adding one requires a certificate to present, and any cert we chose would be the wrong name for the request — the TLS handshake fails more confusingly than the current behaviour. HTTPS to an unknown name on this host is left to the existing first-block behaviour.

- [ ] **Step 2: Create `deploy/nginx/dayzclanwars.com.conf`**

```nginx
# dayzclanwars.com — apex is canonical; www 301s to apex.
#
# ⚠️ Install this AFTER the certificate exists. `nginx -t` fails if an
# ssl_certificate path does not exist, and a failing test means no reload for
# the four other production sites this nginx serves. See the bootstrap vhost
# procedure in docs/deploy/2026-09-03-single-host-deployment.md.

# HTTP: everything to HTTPS apex.
server {
    listen 80;
    listen [::]:80;
    server_name dayzclanwars.com www.dayzclanwars.com;
    return 301 https://dayzclanwars.com$request_uri;
}

# HTTPS www: canonical 301 to apex.
server {
    listen 443 ssl;
    listen [::]:443 ssl;
    server_name www.dayzclanwars.com;

    ssl_certificate /etc/letsencrypt/live/dayzclanwars.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/dayzclanwars.com/privkey.pem;
    include /etc/letsencrypt/options-ssl-nginx.conf;
    ssl_dhparam /etc/letsencrypt/ssl-dhparams.pem;

    return 301 https://dayzclanwars.com$request_uri;
}

# HTTPS apex: proxy to the web container.
server {
    listen 443 ssl;
    listen [::]:443 ssl;
    server_name dayzclanwars.com;

    ssl_certificate /etc/letsencrypt/live/dayzclanwars.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/dayzclanwars.com/privkey.pem;
    include /etc/letsencrypt/options-ssl-nginx.conf;
    ssl_dhparam /etc/letsencrypt/ssl-dhparams.pem;

    # ⚠️ nginx.conf sets `gzip on` globally but leaves gzip_types commented
    # out, so only text/html is compressed by default. Next.js serves its
    # JS and CSS as separate assets; without this line they travel raw.
    gzip_types text/plain text/css application/json application/javascript
               application/x-javascript text/xml application/xml text/javascript
               image/svg+xml;

    # ⚠️ The 33 flag images are fetched by DISCORD, not just browsers:
    # FLAG_IMAGE_BASE_URL=https://dayzclanwars.com means every feed embed
    # thumbnail resolves here. Without this header that traffic lands on this
    # host on every post instead of on Discord's CDN. The pool is fixed at 33
    # and the files are regenerated only by a hand-run script, so they are
    # immutable in practice.
    location /flags/ {
        proxy_pass http://127.0.0.1:3020;
        proxy_set_header Host $host;
        add_header Cache-Control "public, max-age=604800, immutable";
        access_log off;
    }

    location / {
        proxy_pass http://127.0.0.1:3020;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
    }
}
```

- [ ] **Step 3: Create `deploy/systemd/clan-wars-bot.service`**

```ini
[Unit]
# ⚠️ This unit exists to make "exactly one bot instance" enforceable.
# notifyCompleted DMs before it marks, which is correct for one process and
# at-least-once across two; a duplicate DM reached a real player on
# 2026-09-01 because a `pkill -f` pattern failed to match.
#
# On this host the old procedure is worse than imprecise: ~15 dayzonelife.com
# services match `src/main.ts`, so `pkill -f "src/main.ts"` is a site-outage
# command that reads like a cleanup command. systemd's cgroup contains only
# this unit's processes, so `systemctl stop clan-wars-bot` cannot reach them.
Description=Clan Wars Discord bot
After=network-online.target docker.service
Wants=network-online.target

[Service]
Type=simple
User=acab
WorkingDirectory=/opt/clan-wars
# ⚠️ BOT_FEED_CHANNEL_ID must come from the file, not a command line. Passing
# it only on the start command turns the faction feed off at the next restart
# with nothing saying so: faction_events rows keep accumulating unposted and
# the only signal is one warn line at startup.
EnvironmentFile=/opt/clan-wars/.env
ExecStart=/home/acab/.local/bin/pnpm --filter @factions/bot start
# ⚠️ on-failure, not always. A bot that exits deliberately should stay exited.
Restart=on-failure
RestartSec=10
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
```

- [ ] **Step 4: Create `deploy/README.md`**

```markdown
# deploy/

Host configuration for `regime`, the machine running this stack. These files
are the source of truth; `/etc/nginx/sites-enabled/` and `/etc/systemd/system/`
hold symlinks to them.

⚠️ This nginx serves four other production sites (dayzonelife.com,
factory.eli5hq.com, manicdotes.com, regime.fi). Run `sudo nginx -t` before
every reload, and `reload`, never `restart`.

## Install

    sudo ln -s /opt/clan-wars/deploy/nginx/00-default-server.conf \
      /etc/nginx/conf.d/00-default-server.conf
    sudo ln -s /opt/clan-wars/deploy/nginx/dayzclanwars.com.conf \
      /etc/nginx/sites-enabled/dayzclanwars.com
    sudo nginx -t && sudo systemctl reload nginx

    sudo ln -s /opt/clan-wars/deploy/systemd/clan-wars-bot.service \
      /etc/systemd/system/clan-wars-bot.service
    sudo systemctl daemon-reload && sudo systemctl enable --now clan-wars-bot

⚠️ The vhost references `/etc/letsencrypt/live/dayzclanwars.com/`. Install it
only after that certificate exists — `nginx -t` fails on a missing
`ssl_certificate` path, and a failing test blocks reloads for every site here.

## Operating the bot

    systemctl status clan-wars-bot     # includes the cgroup: the real instance count
    sudo systemctl stop clan-wars-bot
    journalctl -u clan-wars-bot -f

⚠️ Never `pkill -f "src/main.ts"` on this host. See the unit file's comment.
```

- [ ] **Step 5: Verify the nginx files are syntactically valid without installing them**

```bash
cd /opt/clan-wars && sudo nginx -t -c /etc/nginx/nginx.conf
```

Expected: `syntax is ok` / `test is successful` — this confirms the *current* config is clean before anything is added, which is the baseline Task 3 needs. The new files are not yet included, so they are not yet tested; that happens at install.

- [ ] **Step 6: Commit**

```bash
cd /opt/clan-wars
git add deploy/
git commit -m "feat(deploy): add nginx vhosts, systemd unit and deploy README

Version controls the host configuration rather than leaving its only copy in
/etc. The default_server closes a cross-site leak: an unmatched Host was being
served by whichever block loaded first."
```

---

## Task 3: Close the unmatched-Host leak

**Files:**
- Install: `/etc/nginx/conf.d/00-default-server.conf` → `deploy/nginx/00-default-server.conf`

**Interfaces:**
- Consumes: `deploy/nginx/00-default-server.conf` (Task 2).
- Produces: unmatched `Host` on :80 returns 444 instead of leaking to dayzonelife.com.

This task touches production nginx for the first time. It is deliberately separate from and before the new vhost, so that if a reload goes wrong there is exactly one change to back out.

- [ ] **Step 1: Record the baseline — all four sites answering**

```bash
for d in dayzonelife.com factory.eli5hq.com manicdotes.com regime.fi; do
  printf '%-24s %s\n' "$d" "$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "https://$d/")"
done
```

Expected: four HTTP codes. **Write them down.** Any code here is the baseline — a 200 or a 301 or a 403 all count; what matters is that Step 5 reproduces the same four.

- [ ] **Step 2: Confirm the leak exists (so the fix is provably the fix)**

```bash
curl -s -o /dev/null -w '%{redirect_url}\n' --max-time 10 -H 'Host: dayzclanwars.com' http://127.0.0.1/
```

Expected: `https://dayzonelife.com/` — a request for one property answered by another.

- [ ] **Step 3: Install and test**

```bash
sudo ln -s /opt/clan-wars/deploy/nginx/00-default-server.conf \
  /etc/nginx/conf.d/00-default-server.conf
sudo nginx -t
```

Expected: `test is successful`.

⚠️ If `nginx -t` reports `a duplicate default server for 0.0.0.0:80`, an existing vhost already declares `default_server`. **Stop.** Remove the symlink, and reconcile by hand — do not reload with a broken config.

- [ ] **Step 4: Reload**

```bash
sudo systemctl reload nginx
```

- [ ] **Step 5: Verify the leak is closed and nothing else moved**

```bash
curl -s -o /dev/null -w 'unmatched host -> %{http_code}\n' --max-time 10 \
  -H 'Host: dayzclanwars.com' http://127.0.0.1/
for d in dayzonelife.com factory.eli5hq.com manicdotes.com regime.fi; do
  printf '%-24s %s\n' "$d" "$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "https://$d/")"
done
```

Expected: the unmatched host gives `000` (curl reporting the connection closed with no response — this is what 444 looks like from the client), and the four codes match Step 1 exactly.

⚠️ If any of the four changed, `sudo rm /etc/nginx/conf.d/00-default-server.conf && sudo nginx -t && sudo systemctl reload nginx` and stop.

- [ ] **Step 6: Commit**

Nothing to commit — this task only installed a symlink. Record the result in the runbook in Task 9.

---

## Task 4: Obtain the certificate

**Files:**
- Create (temporary): `/etc/nginx/sites-enabled/dayzclanwars-bootstrap`

**Interfaces:**
- Consumes: DNS for `dayzclanwars.com` and `www.dayzclanwars.com` already resolving to this host, verified in Step 1.
- Produces: `/etc/letsencrypt/live/dayzclanwars.com/fullchain.pem` and `privkey.pem`, which Task 7's vhost requires.

⚠️ Chicken-and-egg: the final vhost cannot be installed before the cert exists (`nginx -t` fails on a missing `ssl_certificate` path), and certbot's `nginx` authenticator needs a server block matching the name. Hence a bootstrap vhost.

The four existing certs on this host all use `authenticator = nginx` (confirmed in `/etc/letsencrypt/renewal/*.conf`), so this follows the established convention and renewal is already handled by the active `certbot.timer`.

- [ ] **Step 1: Verify DNS and inbound reachability before touching Let's Encrypt**

```bash
dig +short dayzclanwars.com
dig +short www.dayzclanwars.com
curl -s https://api.ipify.org; echo
```

Expected: both names resolve to the same address `api.ipify.org` reports for this host (`187.77.9.189` as of 2026-09-03).

⚠️ If they differ, **stop**. A failed HTTP-01 challenge retries against Let's Encrypt's failed-validation rate limit, which can be exhausted before a correct attempt is ever made.

- [ ] **Step 2: Install the bootstrap vhost**

```bash
sudo tee /etc/nginx/sites-enabled/dayzclanwars-bootstrap > /dev/null <<'EOF'
# TEMPORARY. Exists only so certbot's nginx authenticator has a server block
# matching these names. Task 7 replaces it with the real vhost.
server {
    listen 80;
    listen [::]:80;
    server_name dayzclanwars.com www.dayzclanwars.com;
    return 200 "bootstrap\n";
    add_header Content-Type text/plain;
}
EOF
sudo nginx -t && sudo systemctl reload nginx
```

Expected: `test is successful`, then a silent reload.

- [ ] **Step 3: Confirm the name is now served by intent**

```bash
curl -s --max-time 10 -H 'Host: dayzclanwars.com' http://127.0.0.1/
```

Expected: `bootstrap`. If this returns a redirect to dayzonelife.com, the bootstrap block is not matching and certbot will fail — do not continue.

- [ ] **Step 4: Dry run first**

```bash
sudo certbot certonly --nginx --dry-run \
  -d dayzclanwars.com -d www.dayzclanwars.com
```

Expected: `The dry run was successful.`

⚠️ The dry run uses the staging server and has separate, generous rate limits. It is the whole reason a mistake here is cheap. Do not skip it.

- [ ] **Step 5: Obtain the real certificate**

```bash
sudo certbot certonly --nginx \
  -d dayzclanwars.com -d www.dayzclanwars.com
```

Expected: `Successfully received certificate`, saved to `/etc/letsencrypt/live/dayzclanwars.com/fullchain.pem`.

- [ ] **Step 6: Verify the cert and that renewal is wired up**

```bash
sudo ls -l /etc/letsencrypt/live/dayzclanwars.com/
sudo grep -H "authenticator" /etc/letsencrypt/renewal/dayzclanwars.com.conf
systemctl list-timers | grep certbot
```

Expected: `fullchain.pem` and `privkey.pem` present; `authenticator = nginx`, matching the other four; `certbot.timer` listed as active.

- [ ] **Step 7: Verify the four existing sites are still up**

```bash
for d in dayzonelife.com factory.eli5hq.com manicdotes.com regime.fi; do
  printf '%-24s %s\n' "$d" "$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "https://$d/")"
done
```

Expected: identical to Task 3 Step 1. ⚠️ certbot's nginx authenticator edits nginx config and reverts it; this check confirms the revert was clean.

---

## Task 5: Bring up Postgres and apply all 20 migrations

**Files:**
- Create (temporary, deleted in Step 8): `/opt/clan-wars/migrate-live.tmp.ts`

**Interfaces:**
- Consumes: `DATABASE_URL=postgres://factions:factions@localhost:5434/factions_live` from `.env`.
- Produces: `factions_live` with 20 applied migrations, ready for Task 6's `servers` row.

- [ ] **Step 1: Confirm nothing is already listening on 5434**

```bash
ss -tlnp | grep ':5434' || echo "5434 free"
sudo docker ps --format '{{.Names}}\t{{.Ports}}'
```

Expected: `5434 free` and no containers. ⚠️ If something answers on 5434, stop and identify it before starting a second Postgres.

- [ ] **Step 2: Start Postgres — named, never bare**

```bash
cd /opt/clan-wars && sudo docker compose up -d postgres
```

- [ ] **Step 3: Wait for it to be healthy**

```bash
cd /opt/clan-wars && sudo docker compose ps postgres
```

Expected: status `healthy`. Re-run until it is; the healthcheck polls every 5s with 5 retries.

- [ ] **Step 4: Create `factions_live`**

⚠️ The compose file's `POSTGRES_DB` is `factions`. `factions_live` is a *second* database on the same server, and nothing creates it.

```bash
sudo docker exec clan-wars-postgres-1 psql -U factions -d factions -X \
  -c "create database factions_live owner factions"
sudo docker exec clan-wars-postgres-1 psql -U factions -X -l | grep factions
```

Expected: `CREATE DATABASE`, then both `factions` and `factions_live` listed.

- [ ] **Step 5: Write the guarded migration runner**

⚠️ Nothing applies migrations automatically. `runMigrations` is exported from `packages/db/src/migrate.ts` and called **only from tests**; `apps/bot/src` never calls it and there is no `db:migrate` script. Believing otherwise produced a `column "dormant_since" does not exist` loop on 2026-09-02.

The file must sit at the repo root — `@factions/db` does not resolve from the scratchpad.

```bash
cd /opt/clan-wars && cat > migrate-live.tmp.ts <<'EOF'
import { createClient, runMigrations } from "./packages/db/src/index.js";
const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL unset");
// ⚠️ this script exists to touch the production database; refuse anything else.
if (!url.endsWith("/factions_live")) throw new Error(`refusing: not factions_live -> ${url}`);
const db = createClient(url);
await runMigrations(db);
await (db as any).$client.end();
EOF
```

- [ ] **Step 6: Check what the migrator will apply, before it applies it**

```bash
sudo docker exec clan-wars-postgres-1 psql -U factions -d factions_live -X \
  -c "select count(*) from drizzle.__drizzle_migrations" 2>&1
ls /opt/clan-wars/packages/db/migrations/*.sql | wc -l
```

Expected: an error that the relation does not exist (the schema is empty — correct for a fresh database), and `20` journal files.

⚠️ On an empty table the migrator applies **every** entry. That is right here and only here: this is the one situation where "it applied all of them" is the intended outcome rather than a replay bug.

- [ ] **Step 7: Apply**

```bash
cd /opt/clan-wars && set -a && . ./.env && set +a && npx tsx ./migrate-live.tmp.ts
```

Expected: exits 0 with no error.

- [ ] **Step 8: Verify 20 of 20, then delete the runner**

```bash
sudo docker exec clan-wars-postgres-1 psql -U factions -d factions_live -X \
  -c "select count(*), max(created_at) from drizzle.__drizzle_migrations"
sudo docker exec clan-wars-postgres-1 psql -U factions -d factions_live -X \
  -c "\dt" | head -30
rm /opt/clan-wars/migrate-live.tmp.ts
```

Expected: `count` = **20**. Tables including `factions`, `faction_members`, `faction_invites`, `faction_events`, `servers`, `events`, `raw_lines`, `supply_uploads`.

⚠️ If the count is not 20, do not continue to Task 6. A partial schema fails at runtime, not at startup.

- [ ] **Step 9: Confirm the runner is gone**

```bash
cd /opt/clan-wars && git status --short
```

Expected: clean. ⚠️ `migrate-live.tmp.ts` must never be committed — it is a script whose only purpose is writing to production.

---

## Task 6: Register the game server

**Files:**
- Runs: `apps/ingest-worker/src/register-server.ts` (no changes)

**Interfaces:**
- Consumes: the migrated `factions_live` (Task 5).
- Produces: one row in `servers`, without which the ingest worker sweeps nothing.

> ⚠️ **STOP — this task requires four values the plan cannot supply.** Ask the operator for them before running anything:
>
> - `--name` — the server's display name
> - `--map` — `chernarus`, `livonia` or `sakhal`
> - `--service-id` — the Nitrado service id, which must be visible to the `NITRADO_TOKEN` in `.env`
> - `--offset-ms` — milliseconds to **add** to this server's local ADM time to get UTC
>
> ⚠️ `--offset-ms` has no default by design. A wrong offset stores every
> timestamp hours off while every count-based check stays green — the suite
> passes, the row counts look right, and the data is silently wrong. Measured
> production values recorded in the script: chernarus `14400000` (+4h), livonia
> and sakhal `25200000` (+7h). Confirm which map before choosing.

- [ ] **Step 1: Confirm `servers` is empty**

```bash
sudo docker exec clan-wars-postgres-1 psql -U factions -d factions_live -X \
  -c "select id, name, map, nitrado_service_id, active from servers"
```

Expected: `(0 rows)`.

- [ ] **Step 2: Register, substituting the four values from the operator**

```bash
cd /opt/clan-wars && set -a && . ./.env && set +a && \
  pnpm --filter @factions/ingest-worker exec tsx src/register-server.ts \
    --name "<NAME>" --map <MAP> --service-id <ID> --offset-ms <OFFSET>
```

Expected: `server 1: <NAME> (<MAP>) service <ID>, active=true`.

- [ ] **Step 3: Verify the row, and read the offset back deliberately**

```bash
sudo docker exec clan-wars-postgres-1 psql -U factions -d factions_live -X \
  -c "select id, name, map, nitrado_service_id, clock_offset_ms, active from servers"
```

Expected: exactly one row, `active = t`, and `clock_offset_ms` equal to the value the operator gave. ⚠️ Read this number aloud against the map before continuing — it is the last cheap moment to catch it.

---

## Task 7: Build and start the web app and worker, then publish the vhost

**Files:**
- Install: `/etc/nginx/sites-enabled/dayzclanwars.com` → `deploy/nginx/dayzclanwars.com.conf`
- Remove: `/etc/nginx/sites-enabled/dayzclanwars-bootstrap`

**Interfaces:**
- Consumes: the cert (Task 4), the registered server (Task 6), the compose changes (Task 1).
- Produces: `https://dayzclanwars.com` serving the app.

- [ ] **Step 1: Build both images**

```bash
cd /opt/clan-wars && sudo docker compose build web ingest-worker
```

Expected: both build successfully. The web image is multi-stage and installs a platform-specific `sharp` binary from the lockfile; it was verified on `linux/amd64` and `linux/arm64` on 2026-09-03. Confirm this host's architecture matches one of those:

```bash
uname -m
```

⚠️ If this reports something other than `x86_64` or `aarch64`, the image is on an untested path — build and smoke-test it before trusting it.

- [ ] **Step 2: Start them — named**

```bash
cd /opt/clan-wars && sudo docker compose up -d web ingest-worker
sudo docker compose ps
```

Expected: `postgres`, `web` and `ingest-worker` all running. ⚠️ No `caddy`; after Task 1 there is no such service to start.

- [ ] **Step 3: Verify the app answers on loopback BEFORE nginx points at it**

```bash
curl -s -o /dev/null -w 'app -> %{http_code}\n' --max-time 10 http://127.0.0.1:3020/
curl -s -o /dev/null -w 'flag -> %{http_code}\n' --max-time 10 http://127.0.0.1:3020/flags/Flag_APA.png
```

Expected: both `200`.

⚠️ Doing this before the nginx change is the point: a failure now is unambiguously an app failure. After the proxy is in place the same failure looks like a proxy failure and costs an hour.

- [ ] **Step 4: Swap the bootstrap vhost for the real one**

```bash
sudo rm /etc/nginx/sites-enabled/dayzclanwars-bootstrap
sudo ln -s /opt/clan-wars/deploy/nginx/dayzclanwars.com.conf \
  /etc/nginx/sites-enabled/dayzclanwars.com
sudo nginx -t
```

Expected: `test is successful`. ⚠️ If it fails on the `ssl_certificate` path, Task 4 did not complete — restore the bootstrap vhost and go back.

- [ ] **Step 5: Reload**

```bash
sudo systemctl reload nginx
```

- [ ] **Step 6: Verify the new site and, again, the four existing ones**

```bash
curl -s -o /dev/null -w 'apex   -> %{http_code}\n' --max-time 10 https://dayzclanwars.com/
curl -s -o /dev/null -w 'www    -> %{http_code} %{redirect_url}\n' --max-time 10 https://www.dayzclanwars.com/
curl -s -o /dev/null -w 'http   -> %{http_code} %{redirect_url}\n' --max-time 10 http://dayzclanwars.com/
curl -sI --max-time 10 https://dayzclanwars.com/flags/Flag_APA.png | grep -i 'cache-control\|http/'
for d in dayzonelife.com factory.eli5hq.com manicdotes.com regime.fi; do
  printf '%-24s %s\n' "$d" "$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "https://$d/")"
done
```

Expected: apex `200`; www and http both `301` to `https://dayzclanwars.com/`; the flag image `200` with `Cache-Control: public, max-age=604800, immutable`; and the four existing sites matching their Task 3 Step 1 baseline.

- [ ] **Step 7: Verify the worker is actually ingesting**

Wait two sweep intervals (`INGEST_INTERVAL_SECONDS=60`, so ~2 minutes), then:

```bash
sudo docker compose logs --tail=40 ingest-worker
sudo docker exec clan-wars-postgres-1 psql -U factions -d factions_live -X \
  -c "select count(*) from events"
```

Expected: logs showing sweeps against the registered service, and a non-zero `events` count.

⚠️ A zero count with no errors is the documented silent failure — it means the `servers` row is missing or inactive. Re-check Task 6 rather than assuming the server is simply quiet.

---

## Task 8: Put the bot under systemd

**Files:**
- Install: `/etc/systemd/system/clan-wars-bot.service` → `deploy/systemd/clan-wars-bot.service`

**Interfaces:**
- Consumes: the migrated database (Task 5), `.env` including `BOT_FEED_CHANNEL_ID` and `FLAG_IMAGE_BASE_URL`.
- Produces: a supervised single bot instance.

⚠️ The bot goes last, after migrations. Old code against new schema and new code against old schema both break, and the bot must never be the process that discovers which it is facing.

- [ ] **Step 1: Confirm no bot is already running — WITHOUT the dangerous pattern**

```bash
systemctl is-active clan-wars-bot 2>&1
pgrep -af "filter @factions/bot" || echo "no clan-wars bot running"
```

Expected: `inactive` (or `unknown`), and `no clan-wars bot running`.

⚠️ **Do not** use `ps ax | grep "src/main.ts"` here. It has ~15 permanent false positives on this host from dayzonelife.com, so it can never return the "zero survivors" the old procedure asks for. The `--filter @factions/bot` pattern is specific to this project.

- [ ] **Step 2: Confirm `.env` carries the feed channel**

```bash
grep -c '^BOT_FEED_CHANNEL_ID=' /opt/clan-wars/.env
grep -c '^FLAG_IMAGE_BASE_URL=' /opt/clan-wars/.env
```

Expected: `1` and `1`. ⚠️ If `BOT_FEED_CHANNEL_ID` is missing, the feed is off and `faction_events` rows accumulate unposted with only one warn line at startup to say so.

- [ ] **Step 3: Install and enable the unit**

```bash
sudo ln -s /opt/clan-wars/deploy/systemd/clan-wars-bot.service \
  /etc/systemd/system/clan-wars-bot.service
sudo systemctl daemon-reload
sudo systemctl enable --now clan-wars-bot
```

- [ ] **Step 4: Verify it is up and that there is exactly one**

```bash
systemctl status clan-wars-bot --no-pager
```

Expected: `Active: active (running)`, and the **CGroup** section listing this unit's processes only. ⚠️ Read the instance count from the cgroup, not from `ps | grep` — the cgroup is the authoritative answer to "how many bots are running", and it is exactly what `ps` cannot tell you on this host.

- [ ] **Step 5: Check the logs for a clean start**

```bash
journalctl -u clan-wars-bot -n 60 --no-pager
```

Expected: a successful Discord login and command registration, and **no** `feed channel not configured` warning. ⚠️ Watch specifically for `column ... does not exist` — that would mean Task 5 did not fully apply.

- [ ] **Step 6: Verify a restart does not produce a second instance**

```bash
sudo systemctl restart clan-wars-bot
sleep 15
systemctl status clan-wars-bot --no-pager | sed -n '/CGroup/,$p'
```

Expected: the cgroup lists one `pnpm`/`node` process tree, not two. This is the invariant the whole unit exists for; verify it once, deliberately.

- [ ] **Step 7: Confirm the other project is untouched**

```bash
pgrep -cf "dayzonelife.com"
for d in dayzonelife.com factory.eli5hq.com manicdotes.com regime.fi; do
  printf '%-24s %s\n' "$d" "$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "https://$d/")"
done
```

Expected: the dayzonelife process count unchanged from before this deploy, and the four baseline codes.

---

## Task 9: Correct CLAUDE.md and write the runbook

**Files:**
- Modify: `CLAUDE.md`
- Modify: `apps/web/test/smoke.test.ts`
- Create: `docs/deploy/2026-09-03-single-host-deployment.md`

**Interfaces:**
- Consumes: the observed results of Tasks 3–8.
- Produces: documentation that matches the machine.

⚠️ This is not tidying. Three of the four corrections are hazards: a reader following today's CLAUDE.md would run a command that takes down another production site.

- [ ] **Step 1: Fix the `pkill` hazard in CLAUDE.md**

Replace the bullet beginning "**⚠️ Exactly one bot instance may run.**" with:

```markdown
- **⚠️ Exactly one bot instance may run.** `notifyCompleted` DMs before it marks, which
  is right for one process and at-least-once across two — we shipped a duplicate DM to a
  real player this way on 2026-09-01. The bot runs as a **systemd unit**, which is what
  makes this enforceable: `systemctl status clan-wars-bot` shows the real instance count
  in its cgroup, and `sudo systemctl stop clan-wars-bot` cannot reach anything else.

  ⚠️ **Never run `pkill -f "src/main.ts"` on this host, and never use it as a survivor
  check.** ~15 `dayzonelife.com` services (verifier, api, ingest-worker, projector,
  granter, rebooter, enforcer, crier, newsdesk, notifier and more) match that pattern.
  It is a site-outage command that reads like a cleanup command. If you need a process
  check, `pgrep -af "filter @factions/bot"` is specific to this project.
```

- [ ] **Step 2: Fix the Caddy and VPS claims in CLAUDE.md**

In "Running things", replace the `docker compose up -d postgres ingest-worker` bullet's Caddy warning and the "Web app" bullet with:

```markdown
- **Postgres + ingest worker:** `docker compose up -d postgres ingest-worker` (reads
  `.env`). The worker runs from a built image, so a code change needs
  `docker compose build ingest-worker`. ⚠️ Name the services — a bare `up -d` also
  starts `web`.
- **Web app:** `docker compose build web && docker compose up -d web`. It publishes
  `127.0.0.1:3020` and the **system nginx** terminates TLS for `dayzclanwars.com` and
  proxies to it. There is no Caddy: nginx owns :80/:443 on this host and serves four
  other production sites (dayzonelife.com, factory.eli5hq.com, manicdotes.com,
  regime.fi) from them. ⚠️ Every `systemctl reload nginx` is a reload for all five —
  run `sudo nginx -t` first, and `reload`, never `restart`. Vhost and unit files are
  version controlled in `deploy/`; `/etc` holds symlinks. `pnpm --filter @factions/web dev`
  for local work.
```

Delete the "⚠️ `docker-compose.yml` describes services the VPS must not start" invariant bullet entirely and replace it with:

```markdown
- **⚠️ There is no second machine.** Postgres, the ingest worker, the web app and the
  bot all run on this host, alongside four unrelated production sites. Earlier deploy
  documents describe a separate VPS holding only `web` and `caddy`; that machine does
  not exist and never did on this deployment. Name compose services anyway — a bare
  `up -d` starts more than you mean.
```

- [ ] **Step 3: Replace the "Current state" section in CLAUDE.md**

⚠️ The existing section reports dormancy, rebind and the feed as *deployed* against a `factions_live` holding faction `COK`. That database does not exist. Replace the section's opening with a dated statement of what is true, keeping the feature descriptions (they describe the code, which is real) but removing every claim about applied migrations, live factions and restarts. Add:

```markdown
⚠️ The read-only acceptance check below returns **zero rows** on a fresh database. That
is the same output it gives when "nothing will transition on the next tick" — identical
text, opposite meanings. Read a zero-row result together with `select count(*) from
factions`, or it proves nothing.
```

- [ ] **Step 4: Fix the false docblock in `apps/web/test/smoke.test.ts`**

The docblock claims `factions_live` "lives on a different machine from the VPS". It now lives on the *same* machine. Replace that paragraph with:

```typescript
/**
 * ⚠️ The site is a surface, never a source of truth (spec §3).
 *
 * This test used to be backed up by geography: the web app ran on a VPS with
 * no route to the database. It no longer is — `factions_live` is on the same
 * host now, one loopback port away. The container boundary and this test are
 * the whole of what stands between a Next.js server and production data.
 *
 * It is not a substitute for the design decision; it is what makes the
 * decision expensive to reverse by accident.
 */
```

- [ ] **Step 5: Run the web suite to confirm the edit did not break it**

```bash
cd /opt/clan-wars && npx vitest run --root apps/web
```

Expected: PASS, including `deployment-config.test.ts` from Task 1.

- [ ] **Step 6: Write the runbook**

Create `docs/deploy/2026-09-03-single-host-deployment.md` recording **what actually happened**, not what was planned: the four baseline HTTP codes from Task 3 Step 1 and their post-deploy values, the migration count before and after, the exact `register-server.ts` arguments used, the certbot output, and any step that deviated. Link the spec. ⚠️ Note explicitly that `factions_live` has **no backups** — it is a known, accepted gap recorded in spec §7, not an oversight.

- [ ] **Step 7: Commit**

```bash
cd /opt/clan-wars
git add CLAUDE.md apps/web/test/smoke.test.ts docs/deploy/2026-09-03-single-host-deployment.md
git commit -m "docs: correct CLAUDE.md for the single-host deployment

Four statements were false in damaging directions. The worst: pkill -f
'src/main.ts' matches ~15 dayzonelife.com services on this host, so the
documented way to enforce the single-bot invariant was a site-outage command."
```

---

## Task 10: Run the full gate

**Files:** none.

**Interfaces:**
- Consumes: every preceding task.
- Produces: proof the repo changes did not break the suite.

⚠️ The gate runs against `factions_test_<package>` databases derived from `TEST_DATABASE_URL`'s host, port and credentials — the database it names is discarded. It cannot touch `factions_live`. Running it after the deploy is safe and is the point.

- [ ] **Step 1: Run it**

```bash
cd /opt/clan-wars && TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions" \
  npx turbo run typecheck test --concurrency=1 --force
```

- [ ] **Step 2: Check the count, not the exit code**

Expected: **22/22 tasks** successful. ⚠️ A cached pass proves nothing, which is why `--force` is not optional. If the count is not 22, a package was skipped — investigate before calling this done.

- [ ] **Step 3: Final state check**

```bash
sudo docker compose ps
systemctl is-active clan-wars-bot nginx
sudo docker exec clan-wars-postgres-1 psql -U factions -d factions_live -X -c "
  select (select count(*) from drizzle.__drizzle_migrations) as migrations,
         (select count(*) from servers) as servers,
         (select count(*) from events) as events,
         (select count(*) from factions) as factions"
```

Expected: three containers running (`postgres`, `web`, `ingest-worker`, no `caddy`); both units `active`; `migrations` = 20, `servers` = 1, `events` > 0, `factions` = 0 (nobody has founded one yet on this fresh database).

- [ ] **Step 4: Commit any stragglers and confirm the tree is clean**

```bash
cd /opt/clan-wars && git status --short
```

Expected: clean. ⚠️ Confirm `migrate-live.tmp.ts` is absent.
