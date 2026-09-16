# Automatic Deployment on Release — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A new `vX.Y.Z` tag on `main` deploys itself to `regime` — schema, code, host config and services — rolling back both code and database automatically if any phase fails.

**Architecture:** A systemd timer on the host polls `origin` for a new semver tag and runs one bash script, `deploy/deploy-release.sh`. The script's *decisions* (which tag, has anything relevant changed) live in a new TypeScript package, `@factions/deploy`, so they are covered by the repo's existing vitest gate; the script's *orchestration* (stop, dump, checkout, migrate, start) stays in bash, exercised through a `--dry-run` that executes nothing.

**Tech Stack:** bash, systemd, Docker Compose, TypeScript + vitest (`@factions/deploy`), `tsx` (already how `scripts/*.ts` run).

**Spec:** `docs/superpowers/specs/2026-09-16-auto-deploy-design.md` — read it first; this plan argues from it and does not restate its reasoning.

## Global Constraints

- **Stop all three writers before the dump.** `clan-wars-bot`, `web`, `ingest-worker`. Spec §4's losslessness depends on it entirely; a writer left running makes the automatic restore destructive.
- **`reload`, never `restart`, for nginx.** This host serves dayzonelife.com, manicdotes.com and regime.fi. A restart on a bad config takes all four down; a failed reload leaves the old config live.
- **No webhook on a no-op.** The timer fires every 2 minutes — 720 times a day.
- **State file lives at `/var/lib/clan-wars/deployed-tag`, outside the git tree.** Inside it, the deploy's own `git checkout` would rewrite it.
- **If the rollback itself fails: stop, stay stopped, alert CRITICAL, do not retry.**
- **`pnpm db:migrate` exit codes:** `0` done or dry run, `1` refused/inconsistent, `2` usage error. Live application requires **both** `--apply` and `--production`.
- **The bot is not containerised.** It is a systemd unit run from the working tree. `web` and `ingest-worker` are Docker Compose services.
- **Never `pkill`.** ~15 dayzonelife.com services match `src/main.ts`-style patterns. Use `systemctl`.

---

### Task 1: `@factions/deploy` — newest-tag selection

The one decision that must not be wrong: which tag is "newest". Sorting tags as strings puts `v1.9.0` above `v1.10.0`, and sorting by tag date lets an old tag re-pushed today deploy as if new.

**Files:**
- Create: `packages/deploy/package.json`
- Create: `packages/deploy/tsconfig.json`
- Create: `packages/deploy/vitest.config.ts`
- Create: `packages/deploy/src/tags.ts`
- Create: `packages/deploy/src/index.ts`
- Test: `packages/deploy/test/tags.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `selectNewestTag(tags: string[]): string | null` and `compareSemver(a: string, b: string): number`, both exported from `@factions/deploy`.

- [ ] **Step 1: Scaffold the package**

`packages/deploy/package.json` — mirrors `packages/copy`, which is the repo's minimal no-database package:

```json
{
  "name": "@factions/deploy",
  "version": "0.0.0",
  "type": "module",
  "main": "src/index.ts",
  "exports": {
    ".": "./src/index.ts"
  },
  "scripts": {
    "typecheck": "tsc --noEmit",
    "test": "vitest run"
  },
  "devDependencies": {
    "typescript": "^5.6.0",
    "vitest": "^2.1.0"
  }
}
```

`packages/deploy/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "noEmit": true, "types": ["node"] },
  "include": ["src", "test"]
}
```

`packages/deploy/vitest.config.ts` — the comment matters; it is why this package does not create a `factions_test_deploy` it would never use:

```typescript
import { defineConfig } from "vitest/config";

// No database: every decision here is a pure function over strings. No
// globalSetup, so this package does not create a factions_test_deploy it
// would never use.
export default defineConfig({});
```

- [ ] **Step 2: Write the failing test**

`packages/deploy/test/tags.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { compareSemver, selectNewestTag } from "../src/index";

describe("selectNewestTag", () => {
  it("orders numerically, not lexically", () => {
    // ⚠️ The whole reason this function exists. A string sort puts v1.9.0
    // above v1.10.0 and silently deploys the older release forever.
    expect(selectNewestTag(["v1.9.0", "v1.10.0"])).toBe("v1.10.0");
    expect(selectNewestTag(["v1.2.10", "v1.2.9"])).toBe("v1.2.10");
  });

  it("ignores tags that are not plain vX.Y.Z", () => {
    // Pre-releases and hand-made tags must never be deployed automatically.
    expect(selectNewestTag(["v1.0.0", "v2.0.0-rc1", "nightly", "v1.2"]))
      .toBe("v1.0.0");
  });

  it("returns null when nothing qualifies", () => {
    expect(selectNewestTag([])).toBeNull();
    expect(selectNewestTag(["nightly", "v1.2"])).toBeNull();
  });

  it("is indifferent to input order", () => {
    // Input arrives from `git tag`, whose order is not a promise.
    expect(selectNewestTag(["v0.1.0", "v1.10.0", "v1.9.0"])).toBe("v1.10.0");
    expect(selectNewestTag(["v1.10.0", "v0.1.0", "v1.9.0"])).toBe("v1.10.0");
  });

  it("compares major, then minor, then patch", () => {
    expect(compareSemver("v2.0.0", "v1.99.99")).toBeGreaterThan(0);
    expect(compareSemver("v1.2.0", "v1.1.99")).toBeGreaterThan(0);
    expect(compareSemver("v1.1.1", "v1.1.1")).toBe(0);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `cd packages/deploy && npx vitest run test/tags.test.ts`
Expected: FAIL — cannot resolve `../src/index`.

- [ ] **Step 4: Write the implementation**

`packages/deploy/src/tags.ts`:

```typescript
/** A release tag this deploy system will act on: `v` then three integers. */
const RELEASE_TAG = /^v(\d+)\.(\d+)\.(\d+)$/u;

function parts(tag: string): [number, number, number] | null {
  const m = RELEASE_TAG.exec(tag);
  if (m === null) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/**
 * Semver ordering over release tags. Returns >0 when `a` is newer.
 * Non-release tags sort as older than everything, including each other.
 */
export function compareSemver(a: string, b: string): number {
  const pa = parts(a);
  const pb = parts(b);
  if (pa === null || pb === null) return (pa === null ? 0 : 1) - (pb === null ? 0 : 1);
  for (let i = 0; i < 3; i += 1) {
    if (pa[i] !== pb[i]) return pa[i] - pb[i];
  }
  return 0;
}

/**
 * The newest release tag in `tags`, or null if none qualifies.
 *
 * ⚠️ Ordered by version, never by tag date. `git fetch --tags` reports
 * creation time, so an old tag deleted and re-pushed would look newest and
 * redeploy a past release over the current one.
 */
export function selectNewestTag(tags: string[]): string | null {
  const releases = tags.filter((t) => RELEASE_TAG.test(t));
  if (releases.length === 0) return null;
  return releases.reduce((best, t) => (compareSemver(t, best) > 0 ? t : best));
}
```

`packages/deploy/src/index.ts`:

```typescript
export { compareSemver, selectNewestTag } from "./tags";
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd packages/deploy && npx vitest run test/tags.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 6: Install and confirm the package joins the gate**

Run: `pnpm install`
Run: `TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions" npx turbo run typecheck test --concurrency=1 --force`
Expected: **30 successful, 30 total** — up from 28, because this package adds a `typecheck` and a `test` task.

- [ ] **Step 7: Commit**

```bash
git add packages/deploy pnpm-lock.yaml
git commit -m "feat(deploy): semver tag selection for the release deployer

Ordered by version, never by tag date: git reports tag creation time, so an
old tag deleted and re-pushed would otherwise look newest and redeploy a past
release over the current one."
```

---

### Task 2: changed-path classification

The deploy needs to know whether a release touches host configuration or migrations — for the alert text, and so a human reading the webhook knows whether nginx was reloaded on their behalf.

**Files:**
- Create: `packages/deploy/src/changes.ts`
- Modify: `packages/deploy/src/index.ts`
- Test: `packages/deploy/test/changes.test.ts`

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces: `classifyChanges(paths: string[]): { touchesHostConfig: boolean; touchesMigrations: boolean }`, exported from `@factions/deploy`.

- [ ] **Step 1: Write the failing test**

`packages/deploy/test/changes.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { classifyChanges } from "../src/index";

describe("classifyChanges", () => {
  it("flags nginx and systemd config under deploy/", () => {
    // ⚠️ /etc symlinks into this tree, so these paths are live config for
    // four sites the moment the tag is checked out.
    expect(classifyChanges(["deploy/nginx/dayzclanwars.com.conf"]).touchesHostConfig).toBe(true);
    expect(classifyChanges(["deploy/systemd/clan-wars-bot.service"]).touchesHostConfig).toBe(true);
  });

  it("flags migrations", () => {
    expect(classifyChanges(["packages/db/migrations/0037_x.sql"]).touchesMigrations).toBe(true);
  });

  it("does not flag ordinary code", () => {
    const c = classifyChanges(["apps/bot/src/discord.ts", "CHANGELOG.md"]);
    expect(c.touchesHostConfig).toBe(false);
    expect(c.touchesMigrations).toBe(false);
  });

  it("does not mistake a lookalike path for the real one", () => {
    // `deployment-notes.md` is not `deploy/`, and a substring match would
    // claim nginx was reloaded when it was not.
    const c = classifyChanges(["docs/deployment-notes.md", "apps/web/deploy.ts"]);
    expect(c.touchesHostConfig).toBe(false);
  });

  it("reports both when both changed", () => {
    const c = classifyChanges(["deploy/nginx/a.conf", "packages/db/migrations/0038_y.sql"]);
    expect(c.touchesHostConfig).toBe(true);
    expect(c.touchesMigrations).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/deploy && npx vitest run test/changes.test.ts`
Expected: FAIL — `classifyChanges` is not exported.

- [ ] **Step 3: Write the implementation**

`packages/deploy/src/changes.ts`:

```typescript
/** ⚠️ Prefixes, anchored. A substring test matches `docs/deployment-notes.md`. */
const HOST_CONFIG_PREFIX = "deploy/";
const MIGRATIONS_PREFIX = "packages/db/migrations/";

export interface Changes {
  /** The release edits nginx or systemd config symlinked into /etc. */
  touchesHostConfig: boolean;
  /** The release adds or edits a drizzle migration. */
  touchesMigrations: boolean;
}

export function classifyChanges(paths: string[]): Changes {
  return {
    touchesHostConfig: paths.some((p) => p.startsWith(HOST_CONFIG_PREFIX)),
    touchesMigrations: paths.some((p) => p.startsWith(MIGRATIONS_PREFIX)),
  };
}
```

`packages/deploy/src/index.ts` becomes:

```typescript
export { compareSemver, selectNewestTag } from "./tags";
export { classifyChanges, type Changes } from "./changes";
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd packages/deploy && npx vitest run`
Expected: PASS, 10 tests across both files.

- [ ] **Step 5: Commit**

```bash
git add packages/deploy
git commit -m "feat(deploy): classify a release's changed paths

Anchored prefixes, not substrings: docs/deployment-notes.md is not deploy/,
and a substring match would report an nginx reload that never happened."
```

---

### Task 3: `deploy-select` CLI

Bash needs the answers from Tasks 1–2. This is the seam: one command, JSON out.

**Files:**
- Create: `scripts/deploy-select.ts`
- Modify: `package.json` (root — add the `deploy:select` script and the `@factions/deploy` dependency)
- Test: manual, via the commands in Step 3 (this is a thin I/O shell over tested pure functions)

**Interfaces:**
- Consumes: `selectNewestTag`, `classifyChanges` from `@factions/deploy`.
- Produces: `pnpm deploy:select <current-tag-or-empty>` printing one JSON object to stdout: `{"tag": string|null, "current": string|null, "touchesHostConfig": boolean, "touchesMigrations": boolean}`.

- [ ] **Step 1: Write the script**

`scripts/deploy-select.ts`:

```typescript
/**
 * Decide what deploy-release.sh should do next, as JSON on stdout.
 *
 *   pnpm deploy:select            # nothing deployed yet
 *   pnpm deploy:select v1.9.0     # v1.9.0 is live
 *
 * Reads git; writes nothing. Safe to run at any time.
 */
import { execFileSync } from "node:child_process";
import { classifyChanges, selectNewestTag } from "@factions/deploy";

function git(...args: string[]): string {
  return execFileSync("git", args, { encoding: "utf8" }).trim();
}

const current = process.argv[2] ?? "";

// ⚠️ --merged origin/main: a tag pushed on a branch that never landed is not
// a release, and deploying one would put unreviewed code on production.
const tags = git("tag", "--merged", "origin/main").split("\n").filter(Boolean);
const tag = selectNewestTag(tags);

let changed: string[] = [];
if (tag !== null && current !== "" && tag !== current) {
  changed = git("diff", "--name-only", `${current}..${tag}`).split("\n").filter(Boolean);
}

process.stdout.write(`${JSON.stringify({
  tag,
  current: current === "" ? null : current,
  ...classifyChanges(changed),
})}\n`);
```

- [ ] **Step 2: Wire it into the root `package.json`**

Add to `"scripts"`: `"deploy:select": "tsx scripts/deploy-select.ts"`.
Add to `"dependencies"`: `"@factions/deploy": "workspace:*"` — alongside the existing `@factions/db`, which is there for exactly this reason (root scripts resolving without a `cd`).

- [ ] **Step 3: Run it and verify the shape**

Run: `pnpm install && pnpm deploy:select`
Expected: JSON naming the newest tag, e.g. `{"tag":"v1.9.0","current":null,"touchesHostConfig":false,"touchesMigrations":false}`

Run: `pnpm deploy:select v1.8.0`
Expected: `"current":"v1.8.0"` and the two booleans reflecting what changed between `v1.8.0` and the newest tag.

Run: `pnpm typecheck:scripts`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add scripts/deploy-select.ts package.json pnpm-lock.yaml
git commit -m "feat(deploy): deploy:select, the decision seam for the deploy script

Only tags merged into origin/main qualify: a tag pushed on a branch that never
landed is not a release, and deploying one would put unreviewed code live."
```

---

### Task 4: `deploy-release.sh` — preflight and `--dry-run`

Everything up to the first stop. Every abort here costs nothing, so this is where as many refusals as possible belong.

**Files:**
- Create: `deploy/deploy-release.sh`
- Test: manual, via `--dry-run` (Step 3)

**Interfaces:**
- Consumes: `pnpm deploy:select` from Task 3.
- Produces: `deploy/deploy-release.sh [--dry-run]`; the shell functions `run()`, `state_read()`, `state_write()`, `alert()` used by Tasks 5–8.

- [ ] **Step 1: Write the preflight**

`deploy/deploy-release.sh`:

```bash
#!/usr/bin/env bash
# Deploy the newest release tag to this host, end to end.
#
#   deploy/deploy-release.sh [--dry-run]
#
# Runs from clan-wars-deploy.timer every 2 minutes. Exits 0 and says nothing
# when there is no new tag — see ⚠️ on alert() below.
#
# The sequence and its reasoning: docs/superpowers/specs/2026-09-16-auto-deploy-design.md
set -euo pipefail

REPO=/opt/clan-wars
STATE=/var/lib/clan-wars/deployed-tag
LOCK=/var/lock/clan-wars-deploy
BACKUPS=/var/backups/clan-wars
CONTAINER=clan-wars-postgres-1
PNPM=/home/acab/.local/bin/pnpm

DRY_RUN=0
[ "${1:-}" = "--dry-run" ] && DRY_RUN=1

# ⚠️ Every mutating command goes through run(). --dry-run prints and executes
# nothing, which is the only reviewable artifact this script has.
run() {
  if [ "$DRY_RUN" = "1" ]; then printf 'DRY: %s\n' "$*"; else "$@"; fi
}

state_read()  { cat "$STATE" 2>/dev/null || true; }
state_write() { run mkdir -p "$(dirname "$STATE")"; run sh -c "printf '%s\n' '$1' > '$STATE'"; }

# ⚠️ Never called on a no-op. At a 2-minute interval that is 720 messages a
# day, and an alert channel nobody reads is not an alert channel.
alert() {
  local level="$1" text="$2"
  printf '[%s] %s\n' "$level" "$text"
  [ -n "${DEPLOY_WEBHOOK_URL:-}" ] || return 0
  run curl -fsS -X POST -H 'Content-Type: application/json' \
    -d "$(printf '{"content": "**%s** %s"}' "$level" "$text")" \
    "$DEPLOY_WEBHOOK_URL" >/dev/null || true
}

# ⚠️ flock, not a pidfile. A deploy that outruns the 2-minute timer must not
# have a second copy stopping services underneath it.
exec 9>"$LOCK"
flock -n 9 || exit 0

cd "$REPO"
set -a; . ./.env; set +a

run git fetch --tags --prune origin

CURRENT=$(state_read)
PLAN=$("$PNPM" deploy:select "$CURRENT")
TAG=$(printf '%s' "$PLAN" | python3 -c 'import json,sys; print(json.load(sys.stdin)["tag"] or "")')
HOST_CONFIG=$(printf '%s' "$PLAN" | python3 -c 'import json,sys; print(json.load(sys.stdin)["touchesHostConfig"])')
MIGRATIONS=$(printf '%s' "$PLAN" | python3 -c 'import json,sys; print(json.load(sys.stdin)["touchesMigrations"])')

[ -n "$TAG" ] || exit 0
[ "$TAG" != "$CURRENT" ] || exit 0

# ⚠️ An edit on the box is either an emergency hotfix or a mistake. Both
# deserve a human: `git checkout` would discard either one silently.
if [ -n "$(git status --porcelain)" ]; then
  alert "BLOCKED" "working tree at $REPO is dirty; refusing to deploy $TAG"
  exit 1
fi

echo "deploying $CURRENT -> $TAG (host-config=$HOST_CONFIG migrations=$MIGRATIONS)"

# ⚠️ Build BEFORE stopping anything. This is the longest step; inside the
# outage window it would roughly triple the downtime for no benefit. A failed
# build aborts with nothing stopped and nothing changed.
PREV_IMAGE=$(docker compose images -q web 2>/dev/null || true)
run sudo -n docker compose build -q web
```

- [ ] **Step 2: Make it executable**

Run: `chmod +x deploy/deploy-release.sh`

- [ ] **Step 3: Verify the dry run decides correctly and touches nothing**

Run: `deploy/deploy-release.sh --dry-run`
Expected: either silence and exit 0 (tag already deployed), or a `deploying … -> …` line followed by `DRY: sudo -n docker compose build -q web`. No service is stopped and no file is written.

Run: `git status --porcelain`
Expected: empty — the dry run changed nothing.

- [ ] **Step 4: Commit**

```bash
git add deploy/deploy-release.sh
git commit -m "feat(deploy): release deployer preflight and --dry-run

Every refusal that can happen before the first stop happens here, where
aborting is free: no new tag, a tag already deployed, a dirty working tree, a
failed image build. The build is deliberately before the stop — it is the
longest step, and inside the window it would triple the downtime."
```

---

### Task 5: the outage window

**Files:**
- Modify: `deploy/deploy-release.sh` (append)

**Interfaces:**
- Consumes: `run()`, `alert()`, `$TAG`, `$PREV_IMAGE` from Task 4.
- Produces: `stop_all()`, `start_all()`, `$DUMP` for Tasks 6–7.

- [ ] **Step 1: Append the window**

```bash
stop_all() {
  # ⚠️ All three write to factions_live — the bot every tick, web through
  # packages/roster, the worker through events and the supply upload. The
  # automatic restore in rollback() is only lossless because none of them is
  # running between the dump and the restore.
  # ⚠️ systemctl, never pkill: ~15 dayzonelife.com services match
  # `src/main.ts`-style patterns, and pkill here is a site-outage command.
  run sudo -n systemctl stop clan-wars-bot
  run sudo -n docker compose stop web ingest-worker
}

start_all() {
  run sudo -n docker compose up -d web ingest-worker
  run sudo -n systemctl start clan-wars-bot
}

DUMP="$BACKUPS/predeploy-$TAG.sql.gz"

stop_all

# Same idiom as deploy/backup/backup-factions-live.sh: dump inside the
# container, write .part, rename only on success.
run mkdir -p "$BACKUPS"
if [ "$DRY_RUN" = "0" ]; then
  docker exec "$CONTAINER" pg_dump -U factions -d factions_live --no-owner \
    | gzip -9 > "$DUMP.part"
  mv "$DUMP.part" "$DUMP"

  # ⚠️ Verify BEFORE touching the schema. This is the last moment where
  # aborting costs only the downtime already spent — after the migration
  # there is no way back except this file.
  if ! gzip -t "$DUMP" || [ "$(stat -c %s "$DUMP")" -lt 1000 ]; then
    alert "CRITICAL" "pre-deploy dump for $TAG failed verification; services stopped, NOT deploying"
    start_all
    exit 1
  fi
fi

# ⚠️ From here on, every failure goes through rollback() (Task 7).
# This checkout rewrites live nginx and systemd config: /etc symlinks into
# this tree, and this host serves three other production sites.
run git checkout --quiet "$TAG"

if ! run sudo -n nginx -t; then
  rollback "nginx -t failed after checking out $TAG"
fi

if ! run "$PNPM" db:migrate --apply --production; then
  rollback "migration failed on $TAG"
fi

run sudo -n systemctl daemon-reload
# ⚠️ reload, never restart: a restart on a bad config takes down all four
# sites, where a failed reload leaves the old config live.
run sudo -n systemctl reload nginx

start_all
```

- [ ] **Step 2: Verify the dry run still touches nothing**

Run: `deploy/deploy-release.sh --dry-run`
Expected: `DRY:` lines for stop, checkout, `nginx -t`, migrate, reload, start — in that order. No `pg_dump` runs (it is inside the `DRY_RUN = 0` guard).

Run: `systemctl is-active clan-wars-bot` (on the host) — expected: unchanged.

- [ ] **Step 3: Commit**

```bash
git add deploy/deploy-release.sh
git commit -m "feat(deploy): the outage window — stop, dump, checkout, migrate, start

Dump verification sits before the migration on purpose: it is the last point
where aborting costs only the downtime already spent. After the schema moves,
that file is the only way back."
```

---

### Task 6: the health check

**Files:**
- Modify: `deploy/deploy-release.sh` (append)

**Interfaces:**
- Consumes: `run()`, `$TAG` from Task 4.
- Produces: `health_ok()` returning 0 when healthy, used by Tasks 5 and 7.

- [ ] **Step 1: Append the check**

```bash
# ⚠️ `systemctl is-active` is NOT a health check, and believing it is is the
# easiest mistake available here. CLAUDE.md: the bot holds no eager database
# connection and every tick is individually try/caught, so a bot pointed at a
# dead database reports `active (running)` forever with the whole data path
# down. The HTTP check is the load-bearing one — web reads through
# packages/roster to the database, so a 200 exercises the entire path.
health_ok() {
  local deadline=$((SECONDS + 90))
  while [ "$SECONDS" -lt "$deadline" ]; do
    if docker compose ps postgres --format '{{.Health}}' 2>/dev/null | grep -q healthy \
      && curl -fsS -o /dev/null --max-time 5 http://127.0.0.1:3020/ \
      && docker exec "$CONTAINER" psql -U factions -d factions_live -X -tAc 'select 1' >/dev/null 2>&1 \
      && systemctl is-active --quiet clan-wars-bot
    then
      return 0
    fi
    sleep 5
  done
  return 1
}

if [ "$DRY_RUN" = "1" ]; then
  echo "DRY: health_ok (skipped)"
elif health_ok; then
  state_write "$TAG"
  alert "DEPLOYED" "$TAG is live (host-config=$HOST_CONFIG migrations=$MIGRATIONS)"
else
  rollback "health check failed after deploying $TAG"
fi
```

- [ ] **Step 2: Verify the check against the running host**

⚠️ Do NOT `source` the script to get at the function — sourcing runs the whole
deploy. Run the four conditions by hand on the host instead:

```bash
docker compose ps postgres --format '{{.Health}}'        # expect: healthy
curl -fsS -o /dev/null http://127.0.0.1:3020/ && echo OK # expect: OK
docker exec clan-wars-postgres-1 psql -U factions -d factions_live -X -tAc 'select 1'
systemctl is-active clan-wars-bot                        # expect: active
```

Then stop `web` (`sudo docker compose stop web`), re-run the curl, and confirm it
fails — before starting it again. This proves the check can actually fail. A
health check that never fails is worse than none: it converts every failed
deploy into a silent success.

- [ ] **Step 3: Commit**

```bash
git add deploy/deploy-release.sh
git commit -m "feat(deploy): end-to-end health check as the deploy gate

Four conditions, of which the HTTP 200 is load-bearing: web reads through
packages/roster to the database, so it exercises the whole path. systemctl
is-active deliberately is not the gate — a bot pointed at a dead database
reports active (running) forever with the data path down."
```

---

### Task 7: rollback

**Files:**
- Modify: `deploy/deploy-release.sh` (insert `rollback()` above its first use in Task 5)

**Interfaces:**
- Consumes: `stop_all()`, `start_all()`, `health_ok()`, `$DUMP`, `$CURRENT`, `$PREV_IMAGE`.
- Produces: `rollback(reason)` — never returns; exits 1 on success, 2 when the rollback itself fails.

- [ ] **Step 1: Insert the function**

```bash
# Restore the previous release completely: code, image, host config, schema.
#
# ⚠️ This is lossless ONLY because stop_all() ran before the dump was taken.
# No writer existed between dump and restore, so no player action can be
# destroyed. If a future change starts the services earlier, this function
# becomes a data-loss event and must be reconsidered.
rollback() {
  local reason="$1"
  alert "ROLLING BACK" "$reason"

  stop_all

  if [ "$DRY_RUN" = "0" ]; then
    # Terminate anything still holding the database, or DROP blocks forever.
    docker exec "$CONTAINER" psql -U factions -d factions -X -c \
      "select pg_terminate_backend(pid) from pg_stat_activity where datname = 'factions_live'" >/dev/null
    docker exec "$CONTAINER" psql -U factions -d factions -X -c "drop database factions_live"
    docker exec "$CONTAINER" psql -U factions -d factions -X -c "create database factions_live"
    gzip -dc "$DUMP" | docker exec -i "$CONTAINER" psql -U factions -d factions_live -X -q
  fi

  if [ -n "$CURRENT" ]; then
    run git checkout --quiet "$CURRENT"
  fi
  # ⚠️ The tag to restore is whatever compose calls this service's image —
  # it is derived from the compose project name, NOT necessarily
  # `clan-wars-web:latest`. Confirm it on the host with
  # `docker compose config --images web` before trusting this line; a wrong
  # tag here means the rollback silently leaves the NEW image running while
  # reporting success.
  if [ -n "$PREV_IMAGE" ]; then
    run docker tag "$PREV_IMAGE" "$(docker compose config --images web)"
  fi

  run sudo -n systemctl daemon-reload
  run sudo -n nginx -t && run sudo -n systemctl reload nginx

  start_all

  if [ "$DRY_RUN" = "1" ] || health_ok; then
    alert "ROLLED BACK" "restored $CURRENT after: $reason"
    exit 1
  fi

  # ⚠️ Stop, and stay stopped. Do NOT retry. A deploy loop thrashing against
  # a database it cannot read is how the 2026-09-01 duplicate-DM incident
  # reaches a real player; a stopped bot is a visible outage a human fixes,
  # which is strictly better.
  stop_all
  alert "CRITICAL" "ROLLBACK FAILED after: $reason — services STOPPED, needs a human. Dump: $DUMP"
  exit 2
}
```

- [ ] **Step 2: Verify the dry run reaches rollback without executing it**

Run: `deploy/deploy-release.sh --dry-run`
Expected: completes with `DRY: health_ok (skipped)` and no rollback — the dry run's `run()` never fails, so no failure path triggers.

Run: `bash -n deploy/deploy-release.sh`
Expected: no output (syntax valid, and `rollback` is defined before its first use).

- [ ] **Step 3: Commit**

```bash
git add deploy/deploy-release.sh
git commit -m "feat(deploy): automatic rollback of code, image, config and schema

Lossless only because stop_all() precedes the dump — no writer exists between
dump and restore, so no player action can be destroyed. A comment says so, at
the function, because a future change that starts services earlier would turn
this into a data-loss event silently.

A failed rollback stops and stays stopped rather than retrying."
```

---

### Task 8: systemd units and the webhook

**Files:**
- Create: `deploy/systemd/clan-wars-deploy.service`
- Create: `deploy/systemd/clan-wars-deploy.timer`
- Modify: `deploy/README.md`

**Interfaces:**
- Consumes: `deploy/deploy-release.sh`.
- Produces: the installed timer.

- [ ] **Step 1: Write the units**

`deploy/systemd/clan-wars-deploy.service`:

```ini
[Unit]
# Polls for a new release tag and deploys it. See deploy-release.sh.
Description=Clan Wars release deployer
After=network-online.target docker.service
Wants=network-online.target

[Service]
Type=oneshot
User=acab
WorkingDirectory=/opt/clan-wars
# ⚠️ DEPLOY_WEBHOOK_URL comes from the file. The bot is stopped for most of a
# deploy and may be the thing that failed, so the alert path must not share a
# failure domain with it.
EnvironmentFile=/opt/clan-wars/.env
ExecStart=/opt/clan-wars/deploy/deploy-release.sh
StandardOutput=journal
StandardError=journal
```

`deploy/systemd/clan-wars-deploy.timer`:

```ini
[Unit]
Description=Poll for a new Clan Wars release every 2 minutes

[Timer]
OnBootSec=5min
OnUnitActiveSec=2min
# ⚠️ No Persistent=true. A missed poll is not worth catching up on — the next
# one is two minutes away, and catching up would fire a deploy at boot.
AccuracySec=30s

[Install]
WantedBy=timers.target
```

- [ ] **Step 2: Add `DEPLOY_WEBHOOK_URL` to `.env` on the host**

Create a Discord webhook in the ops channel (Channel Settings → Integrations → Webhooks) and append `DEPLOY_WEBHOOK_URL=<url>` to `/opt/clan-wars/.env`.
⚠️ Not committed — `.env` is gitignored and has never been in this repo's history.

- [ ] **Step 3: Document the install in `deploy/README.md`**

Add under "Install":

```markdown
    sudo ln -s /opt/clan-wars/deploy/systemd/clan-wars-deploy.service \
      /etc/systemd/system/clan-wars-deploy.service
    sudo ln -s /opt/clan-wars/deploy/systemd/clan-wars-deploy.timer \
      /etc/systemd/system/clan-wars-deploy.timer
    sudo systemctl daemon-reload && sudo systemctl enable --now clan-wars-deploy.timer

⚠️ The deploy state lives at `/var/lib/clan-wars/deployed-tag`, deliberately
outside this tree: a file inside it would be rewritten by the deploy's own
`git checkout`, so a rollback would restore a file claiming the rollback never
happened. Seed it with the tag currently live before enabling the timer, or the
first run deploys the newest tag over whatever is there:

    echo v1.9.0 | sudo tee /var/lib/clan-wars/deployed-tag
```

- [ ] **Step 4: Verify the timer arms without deploying**

Run (host): `sudo systemctl daemon-reload && systemctl list-timers clan-wars-deploy`
Expected: listed, with a next-elapse time.
Run: `journalctl -u clan-wars-deploy -n 20`
Expected: a run that exits 0 silently, because the state file matches the newest tag.

- [ ] **Step 5: Commit**

```bash
git add deploy/systemd/clan-wars-deploy.service deploy/systemd/clan-wars-deploy.timer deploy/README.md
git commit -m "feat(deploy): systemd timer for the release deployer

No Persistent=true: a missed poll is not worth catching up on, and catching up
would fire a deploy at boot. The state file lives outside the git tree because
the deploy's own checkout would otherwise rewrite it."
```

---

### Task 9: documentation — including the invariant this reverses

**Files:**
- Create: `docs/deploy/2026-09-16-auto-deploy.md`
- Modify: `CLAUDE.md`
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Rewrite the `CLAUDE.md` invariant**

Find the bullet beginning **"⚠️ Nothing applies migrations automatically."** in "Running things" and replace its opening with:

```markdown
- **⚠️ Migrations are applied automatically on a release deploy, and by nothing
  else.** `clan-wars-deploy.timer` runs `deploy/deploy-release.sh`, which stops
  all three writers, dumps `factions_live`, and only then runs
  `pnpm db:migrate --apply --production` — rolling code, image, host config and
  schema back if anything after the checkout fails. Outside that script nothing
  migrates: not the bot, not the site, not a container entrypoint. A migration
  you apply by hand is still `pnpm db:migrate`, and the stop-the-bot-first rule
  still applies to it. ⚠️ This reverses what this file said until 2026-09-16;
  the 2026-09-02 `dormant_since` incident is why it said otherwise, and the
  stop-first ordering in the deploy script is what makes the reversal safe.
```

- [ ] **Step 2: Write the runbook**

`docs/deploy/2026-09-16-auto-deploy.md` — covering: install (symlinks, `daemon-reload`, seeding the state file), the webhook, how to deploy manually if the timer is off (`deploy/deploy-release.sh`), how to **disable** it in a hurry (`sudo systemctl disable --now clan-wars-deploy.timer`), where the pre-deploy dumps land (`/var/backups/clan-wars/predeploy-<tag>.sql.gz`), and what to do after a `CRITICAL` alert (services are stopped deliberately; restore from the named dump, then start by hand).

- [ ] **Step 3: Add the changelog entry**

Under `## [Unreleased]`, `### Added`:

```markdown
- Releases deploy themselves: a new `vX.Y.Z` tag on `main` is deployed to
  production within two minutes, applying migrations and rolling back code,
  image, host config and database together if any phase fails.
```

- [ ] **Step 4: Run the full gate**

Run: `TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions" npx turbo run typecheck test --concurrency=1 --force`
Expected: **30 successful, 30 total**, 0 cached.

⚠️ Also update the "Expect **28/28 tasks**" line in `CLAUDE.md` to 30/30, naming `packages/deploy` alongside the other packages listed there. Two statements of one fact, and this one has no test holding it honest.

- [ ] **Step 5: Commit and open the PR**

```bash
git add CLAUDE.md CHANGELOG.md docs/deploy/2026-09-16-auto-deploy.md
git commit -m "docs: the deploy runbook, and the migration invariant it reverses

CLAUDE.md said nothing applies migrations automatically. That is now false, and
a file that contradicts the system is worse than one that is merely incomplete."
```

---

## Rehearsal — required before this is trusted

⚠️ Until both of these have run, the rollback is a design, not a capability, and must not be described as one (spec §8).

- [ ] **Rehearsal 1 — no-op release.** Tag a commit that changes nothing (`git tag v1.9.1 && git push origin v1.9.1`). Watch `journalctl -u clan-wars-deploy -f`. The full path runs — stop, dump, checkout, migrate (no-op), start, health check — with nothing at stake. Expect a `DEPLOYED` webhook and roughly 1–3 minutes of downtime.

- [ ] **Rehearsal 2 — deliberate rollback, while watching.** Temporarily point `health_ok`'s curl at a port nothing serves, tag a release, and confirm: the database comes back, `git describe --tags` reports the previous tag, the site returns, and the webhook says `ROLLED BACK`. Then revert the sabotage. Do this at a quiet hour, at a terminal, with `/var/backups/clan-wars/` in view.
