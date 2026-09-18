# Release Announcements Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every release this project has cut, and every release it cuts from now on, posts its `CHANGELOG.md` notes to Discord channel `1549900456078090260` after a verified deploy.

**Architecture:** `CHANGELOG.md` is the single source. A pure parser in `packages/deploy` turns it into releases; `pnpm release:sync` inserts a row per unannounced version into `release_announcements`; a bot tick drains that queue oldest-first, post-then-mark, stopping at the first failure. `deploy/deploy-release.sh` calls `release:sync` in its bookkeeping block after a healthy deploy — so the backfill and the per-deploy hook are one code path.

**Tech Stack:** TypeScript, pnpm workspace + turbo, drizzle-orm over postgres.js, discord.js, vitest, bash.

**Spec:** `docs/superpowers/specs/2026-09-17-release-announcements-design.md`

## Global Constraints

- **Two PRs, in order.** Phase 1 (tasks 1–5) is the CHANGELOG backfill, content only. Phase 2 (tasks 6–13) is the feature. Phase 2's tests use Phase 1's v1.0.0 entry as a fixture, so Phase 1 merges first.
- **Every PR adds an entry under `## [Unreleased]` in `CHANGELOG.md`, committed** — the `changelog` CI gate diffs against the committed state at the PR base, so a staged or on-disk edit does not satisfy it.
- **The full gate, and always with `--force`:**
  `TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions" npx turbo run typecheck test --concurrency=1 --force`
  Expect **30/30 tasks**. A cached pass proves nothing; check the count, not the exit code.
- **Never run the gate twice at once**, and never run a package's `vitest` by hand while `turbo run test` is also running — `factions_test_<package>` is derived from the package name alone, so two concurrent runs write into the same tables and produce failures that look exactly like real regressions.
- **Import extensions differ by package.** `packages/deploy/src/` uses **extensionless** relative imports (`from "./tags"`); `apps/bot/src/` uses **`.js`** (`from "./war-log-tick.js"`). Match the file you are in.
- **Comments explain WHY, not what.** `⚠️` marks a line whose failure mode is silent. Match the density of the file being edited. This is house style and review enforces it.
- **Branch flow is keel's:** `keel:start-work` to branch, `keel:finish-work` to open the PR, `keel:review`, then `keel:land` (merges with `--merge`, never `--squash`).
- **Channel id:** `1549900456078090260`, configured as `RELEASE_CHANNEL_ID`. It is never hard-coded in source.
- **Discord embed description cap:** `4096` characters. This is the only size limit in play; the notes go out as embeds, not as message content (2000).

---

## Phase 1 — the CHANGELOG backfill (PR 1)

`CHANGELOG.md` currently records v1.16.0 onward. v1.0.0–v1.15.0 are missing, and Phase 2 has nothing to announce for them until they exist.

The material is the annotated tag messages. Read one with:

```bash
git tag -l --format='%(contents)' v1.15.0
```

Every tag from v1.1.0 to v1.15.0 carries a substantial body. v1.16.0, v1.16.1–v1.16.6 and v1.17.0 carry only a subject or nothing — those versions are **already in the changelog** and are not touched by this phase.

**The shape of every entry**, using v1.15.0 as the worked example. The tag body is prose; the changelog entry is that prose reorganised under Keep a Changelog headings, keeping the ⚠️ operational notes verbatim in substance:

```markdown
## [1.15.0] - 2026-09-15

### Added

- Automated base-zone enforcement. A non-member who builds, dismantles, or
  stacks fireplaces and garden plots inside a declared base's 100 m watch zone
  is recorded and warned. Nothing happens until the base's owner presses charges
  from `/base` — and then the ban is automatic, scaled to the damage, with no
  staff step. The bot only ever sentences incidents it witnessed itself: a
  report carries no free text and cannot describe an act the log did not record.
- The sentence: 24h base, +48h for any breach, +24h for a fence-to-gate, +12h
  per part dismantled, capped at 7 days on a first offence, doubled on the
  second, permanent on the third in a season.
- Migration 0036 adds `zone_incidents`, `zone_violations`, `zone_placements`,
  `zone_incident_participants` and `bans`. CREATE only.
- Runbook: `docs/deploy/2026-09-15-zone-enforcement.md`.

### Changed

- Dismantling a base that is not yours is a violation 24/7. The "inside the
  window, dismantling while raiding is part of raiding" carve-out is deleted.
- Building anything inside someone else's watch zone is a breach — watchtower,
  fence, anything.
- Stacked fireplaces and garden plots move off the permanent-ban exploit list
  onto the proportional ladder.
- These three skip the ticket queue. Every other fair-play rule still needs one.
  (`apps/web/content/guide/12-fair-play.html`)

### Notes

- ⚠️ Ships dark. `ENFORCEMENT_TICK` defaults off and `BAN_DRY_RUN` defaults
  true: audit rows are always written, and a real ban needs both flags set
  deliberately. The dry-run week is where `BOOST_STACK_RADIUS_M` and
  `BOOST_STACK_MIN_RISE_M` get tuned before anyone is banned.
- ⚠️ `parity.test.ts`'s `PENDING` list is no longer empty. `reportIncident` is
  deferred deliberately: the evidence an officer needs to judge a report cannot
  appear in Discord under `clan_notices_no_coordinates`, so the decision surface
  is the owner-gated `/base` page.
```

`### Notes` is not a Keep a Changelog heading, but the ⚠️ operational warnings in these tags are the most valuable thing in them and belong under a heading of their own rather than buried in `Added`. Use it only where a tag body has such warnings.

### Task 1: Branch, and backfill v1.15.0 → v1.10.0

**Files:**
- Modify: `CHANGELOG.md` (insert below the `## [1.16.0]` section)

- [ ] **Step 1: Branch**

```bash
git fetch origin main
git checkout -b feature/changelog-backfill origin/main
test -f .keel.json && echo present || echo MISSING
```

- [ ] **Step 2: Read the six tag bodies and the commits behind each**

```bash
for t in v1.10.0 v1.11.0 v1.12.0 v1.13.0 v1.14.0 v1.15.0; do
  echo "########## $t"
  git tag -l --format='%(contents)' "$t"
done
git log --oneline v1.9.0..v1.15.0
```

The `git log` pass is for catching what a tag body omitted — a fix that shipped in the same release but did not make the annotation. Anything it turns up that matters to a reader goes in the entry; pure internal churn does not.

- [ ] **Step 3: Write the six entries**

`## [1.16.0]` is currently the **last** section in the file. Append the six new sections after it, in descending order (1.15.0 first, 1.10.0 last), so the file stays newest-first throughout. Dates come from the tags:

```bash
git for-each-ref --sort=creatordate --format='%(refname:short) %(creatordate:short)' refs/tags
```

v1.10.0 = 2026-09-13, v1.11.0 = 2026-09-14, v1.12.0 = 2026-09-14, v1.13.0 = 2026-09-14, v1.14.0 = 2026-09-14, v1.15.0 = 2026-09-15.

Follow the v1.15.0 example above exactly for structure. Wrap prose at the width the rest of the file uses (~80 columns).

- [ ] **Step 4: Check the file still parses as Keep a Changelog**

```bash
grep -n '^## ' CHANGELOG.md
```

Expected: `## [Unreleased]` first, then versions in strictly descending order with no duplicates and no gaps among the versions written so far.

- [ ] **Step 5: Commit**

```bash
git add CHANGELOG.md
git commit -m "docs(changelog): backfill v1.10.0 through v1.15.0 from the release tags"
```

### Task 2: Backfill v1.9.0 → v1.5.0

**Files:**
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Read the five tag bodies and their commits**

```bash
for t in v1.5.0 v1.6.0 v1.7.0 v1.7.1 v1.8.0 v1.9.0; do
  echo "########## $t"
  git tag -l --format='%(contents)' "$t"
done
git log --oneline v1.4.0..v1.9.0
```

Note v1.7.1 is in this range too — six tags, not five. It is a patch release ("keep `@factions/copy` a leaf; v1.7.0's web image does not build") and gets a `### Fixed` entry of its own, not a merge into v1.7.0. A release that happened is a release that gets a section.

- [ ] **Step 2: Write the six entries**

Same structure as Task 1. Dates: v1.5.0 = 2026-09-12, v1.6.0 = 2026-09-12, v1.7.0 = 2026-09-13, v1.7.1 = 2026-09-13, v1.8.0 = 2026-09-13, v1.9.0 = 2026-09-13.

- [ ] **Step 3: Re-check the heading order**

```bash
grep -n '^## ' CHANGELOG.md
```

Expected: still strictly descending, now down to `## [1.5.0]`.

- [ ] **Step 4: Commit**

```bash
git add CHANGELOG.md
git commit -m "docs(changelog): backfill v1.5.0 through v1.9.0 from the release tags"
```

### Task 3: Backfill v1.4.0 → v1.1.0

**Files:**
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Read the four tag bodies and their commits**

```bash
for t in v1.1.0 v1.2.0 v1.3.0 v1.4.0; do
  echo "########## $t"
  git tag -l --format='%(contents)' "$t"
done
git log --oneline v1.0.0..v1.4.0
```

- [ ] **Step 2: Write the four entries**

Same structure. Dates: v1.1.0 = 2026-09-09, v1.2.0 = 2026-09-09, v1.3.0 = 2026-09-09, v1.4.0 = 2026-09-12.

- [ ] **Step 3: Re-check the heading order**

```bash
grep -n '^## ' CHANGELOG.md
```

Expected: strictly descending, down to `## [1.1.0]`.

- [ ] **Step 4: Commit**

```bash
git add CHANGELOG.md
git commit -m "docs(changelog): backfill v1.1.0 through v1.4.0 from the release tags"
```

### Task 4: Reconstruct v1.0.0

**Files:**
- Modify: `CHANGELOG.md`

v1.0.0's annotation is one line — "the target-state build order complete (increments 0–8)" — over roughly 700 commits. It is written from the specs and runbooks as **what the game had when 1.0.0 shipped**, not as a commit list.

- [ ] **Step 1: Read the sources**

```bash
ls docs/superpowers/specs/ docs/deploy/
sed -n '1,120p' docs/superpowers/specs/2026-09-04-clan-wars-target-state-design.md
sed -n '1,80p' docs/deploy/2026-09-10-launch.md
```

`CLAUDE.md`'s "Current state" section also narrates increments 2a → 8 in order and is a faster read than the specs for the sequence.

- [ ] **Step 2: Write the entry**

One `## [1.0.0] - 2026-09-07` section at the bottom of the file, with a short lead paragraph and an `### Added` list of the capabilities that shipped — one bullet per increment, not per commit. The increments, from `CLAUDE.md`:

| Increment | What it shipped |
|---|---|
| 0–1 | Declarations: the 200 m rule, `declareTx`, the solo lapse clock |
| 2a | Site foundation: Tailwind, `packages/roster`, `/me` from the database |
| 2b | `/link` identity linking, unlink, `/base` solo declare and release |
| 2c-a/b | The roster store, pending/full membership, join requests, the recruiting post; roster administration moves to the site |
| 3a | Raids, defenses, dormancy revival, the notice and war-log queues |
| 3b | Discord structure: roles, clan channels, `@Linked`, the structure reconciler |
| 4 | Scoring, seasons, weeks, Alphas, `#war-log` |
| 5 | The map: positions, intruder sightings, the four map rules |
| 6 | Sessions, kills, membership history |
| 7 | Leadership: succession claims, no-confidence votes, the vault, guest passes |
| 8 | Launch: the guide, `pnpm launch`, the raid window |

Also name in the entry: the faction feed, faction dormancy, faction rebind, and the supply-spawner projection — all in place by 1.0.0 and all described in `CLAUDE.md`.

- [ ] **Step 3: Verify the file is complete**

```bash
grep -c '^## \[' CHANGELOG.md
```

Expected: `26` — `[Unreleased]` plus 25 releases, one per tag.

```bash
comm -3 \
  <(git tag | sed 's/^v//' | sort) \
  <(grep -o '^## \[[0-9][^]]*\]' CHANGELOG.md | tr -d '#[] ' | sort)
```

Expected: no output. Any line printed is a tag with no changelog section (left column) or a section with no tag (right column) — and a tag with no section is a release that will never be announced, silently.

- [ ] **Step 4: Commit**

```bash
git add CHANGELOG.md
git commit -m "docs(changelog): reconstruct the v1.0.0 entry from the increment specs"
```

### Task 5: Unreleased entry and PR

**Files:**
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Add the Unreleased entry**

Under `## [Unreleased]`, in the existing `### Added` list:

```markdown
- `CHANGELOG.md` now records every release back to v1.0.0. The v1.1.0–v1.15.0
  entries are reconstructed from the release tags' annotations and the commits
  behind them; v1.0.0 is written from the increment specs, since its tag carries
  only a subject line.
```

- [ ] **Step 2: Commit**

```bash
git add CHANGELOG.md
git commit -m "docs(changelog): record the backfill under Unreleased"
```

- [ ] **Step 3: Open the PR**

Use the `keel:finish-work` skill. Base is `main`.

- [ ] **Step 4: Land it**

`keel:review`, then `keel:land`. Phase 2 branches from the result.

---

## Phase 2 — release announcements (PR 2)

### File structure

| File | Responsibility |
|---|---|
| `packages/deploy/src/changelog.ts` | **Create.** Parse `CHANGELOG.md` text into releases, ascending by semver. Pure. |
| `packages/deploy/src/index.ts` | Modify. Export the parser. |
| `packages/deploy/test/changelog.test.ts` | **Create.** Parser tests. |
| `packages/db/src/schema.ts` | Modify. `releaseAnnouncements` table. |
| `packages/db/migrations/0038_*.sql` | **Create** (generated). |
| `scripts/release-sync.ts` | **Create.** `pnpm release:sync`. Reads the changelog, inserts unannounced versions. |
| `package.json` | Modify. The `release:sync` script entry. |
| `apps/bot/src/release-text.ts` | **Create.** Row → `APIEmbed[]`, including the 4096 split. Pure. |
| `apps/bot/test/release-text.test.ts` | **Create.** Rendering and split tests. |
| `apps/bot/src/release-tick.ts` | **Create.** The queue drain, plus the drizzle-backed store. |
| `apps/bot/test/release-tick.test.ts` | **Create.** Tick tests over an in-memory store. |
| `apps/bot/src/config.ts` | Modify. `releaseChannelId`. |
| `apps/bot/src/discord.ts` | Modify. Poster, tick block, startup warn. |
| `apps/bot/README.md` | Modify. The env table row. |
| `deploy/deploy-release.sh` | Modify. One `release:sync` call in the bookkeeping block. |
| `docs/deploy/2026-09-17-release-announcements.md` | **Create.** The runbook. |
| `CLAUDE.md` | Modify. Where it lives, and the re-post hazard. |

### Task 6: The changelog parser

**Files:**
- Create: `packages/deploy/src/changelog.ts`
- Modify: `packages/deploy/src/index.ts`
- Test: `packages/deploy/test/changelog.test.ts`

**Interfaces:**
- Consumes: `compareSemver(a: string, b: string): number` from `./tags` — it takes **`v`-prefixed** tags and sorts non-release strings as older than everything.
- Produces: `parseChangelog(text: string): ChangelogRelease[]`, and `interface ChangelogRelease { version: string; date: string; body: string }`. `version` has **no** `v` prefix ("1.17.0"). Tasks 7 and 10 depend on both.

- [ ] **Step 1: Branch from the landed Phase 1**

```bash
git fetch origin main
git checkout -b feature/release-announcements origin/main
grep -c '^## \[' CHANGELOG.md
```

Expected: `26`. If it is not, Phase 1 has not landed and this task cannot proceed.

- [ ] **Step 2: Write the failing test**

Create `packages/deploy/test/changelog.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { parseChangelog } from "../src/changelog";

const SAMPLE = `# Changelog

All notable changes to this project are documented in this file.

## [Unreleased]

### Added

- Something not yet released.

## [1.10.0] - 2026-09-13

### Added

- The tenth release.

### Fixed

- A thing that was broken.

## [1.9.0] - 2026-09-13

### Added

- The ninth release.

## [1.8.0] - 2026-09-13 [WITHDRAWN]

Not a release. A deliberately unhealthy build, cut to rehearse a rollback.
**Never deploy this tag.**
`;

describe("parseChangelog", () => {
  it("returns one release per version heading, skipping Unreleased", () => {
    const releases = parseChangelog(SAMPLE);

    expect(releases.map((r) => r.version)).toEqual(["1.9.0", "1.10.0"]);
  });

  it("orders by semver, not lexically", () => {
    // ⚠️ The case a string sort gets wrong: "1.10.0" < "1.9.0" lexically.
    const releases = parseChangelog(SAMPLE);

    expect(releases[0]!.version).toBe("1.9.0");
    expect(releases[1]!.version).toBe("1.10.0");
  });

  it("carries the date from the heading", () => {
    expect(parseChangelog(SAMPLE)[1]!.date).toBe("2026-09-13");
  });

  it("keeps ### subsections in the body and stops at the next ## heading", () => {
    const body = parseChangelog(SAMPLE)[1]!.body;

    expect(body).toContain("### Added");
    expect(body).toContain("### Fixed");
    expect(body).toContain("- The tenth release.");
    expect(body).not.toContain("The ninth release");
    expect(body).not.toContain("## [1.9.0]");
  });

  it("skips a [WITHDRAWN] heading", () => {
    // ⚠️ Load-bearing, and the reason the heading regex is anchored. v1.16.2
    // and v1.16.4 are real sections in this repo's CHANGELOG.md that say
    // "Not a release … Never deploy this tag" — deliberately unhealthy builds
    // cut to rehearse the deployer's rollback. Announcing one to players would
    // advertise a build that does not exist. The marker IS the per-release
    // opt-out; nothing else provides one.
    expect(parseChangelog(SAMPLE).map((r) => r.version)).not.toContain("1.8.0");
  });

  it("returns nothing for a changelog with no releases", () => {
    expect(parseChangelog("# Changelog\n\n## [Unreleased]\n\n- nothing yet\n")).toEqual([]);
  });

  it("parses the repository's own CHANGELOG.md", async () => {
    // ⚠️ The real file, not a fixture. A format change that the sample above
    // does not happen to cover would otherwise only show up in production,
    // where the symptom is a release that is silently never announced.
    const { readFile } = await import("node:fs/promises");
    const text = await readFile(new URL("../../../CHANGELOG.md", import.meta.url), "utf8");

    const releases = parseChangelog(text);

    // 26 `## [` headings minus `[Unreleased]` minus the two [WITHDRAWN] tags.
    expect(releases.length).toBe(23);
    expect(releases[0]!.version).toBe("1.0.0");
    expect(releases.map((r) => r.version)).not.toContain("1.16.2");
    expect(releases.map((r) => r.version)).not.toContain("1.16.4");
    expect(releases.every((r) => /^\d{4}-\d{2}-\d{2}$/u.test(r.date))).toBe(true);
    expect(releases.every((r) => r.body.length > 0)).toBe(true);
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

```bash
cd packages/deploy && npx vitest run test/changelog.test.ts
```

Expected: FAIL — `Failed to resolve import "../src/changelog"`.

- [ ] **Step 4: Write the implementation**

Create `packages/deploy/src/changelog.ts`:

```ts
import { compareSemver } from "./tags";

/**
 * `## [1.17.0] - 2026-09-17`. Anchored at both ends, which is load-bearing:
 * `[Unreleased]` has no date and does not match, and neither does
 * `## [1.16.2] - 2026-09-17 [WITHDRAWN]` — a tag this repo records as "not a
 * release, never deploy this tag". ⚠️ The trailing `$` is therefore the only
 * thing keeping a rehearsal build out of a player-facing channel. A future
 * "tidy-up" that loosens this regex announces both withdrawn tags.
 */
const HEADING = /^## \[(\d+\.\d+\.\d+)\]\s*-\s*(\d{4}-\d{2}-\d{2})\s*$/u;

export interface ChangelogRelease {
  /** Without the leading `v` — "1.17.0", as the heading writes it. */
  version: string;
  /** As written in the heading: "2026-09-17". */
  date: string;
  /** Everything under the heading, trimmed. Markdown, verbatim. */
  body: string;
}

/**
 * The releases in a Keep a Changelog file, oldest first.
 *
 * ⚠️ Ascending, though the file is newest-first: `release:sync` inserts in this
 * order and the bot posts by insert id, so this sort is what puts v1.0.0 above
 * v1.10.0 in the channel. A lexical sort would put v1.10.0 first.
 *
 * ⚠️ A version with no `- YYYY-MM-DD` on its heading does not match and is
 * therefore never announced. That is deliberate: the date becomes `released_at`,
 * and an announcement is not worth inventing a date for.
 */
export function parseChangelog(text: string): ChangelogRelease[] {
  const out: ChangelogRelease[] = [];
  let open: { version: string; date: string; body: string[] } | null = null;

  const close = (): void => {
    if (open === null) return;
    out.push({ version: open.version, date: open.date, body: open.body.join("\n").trim() });
    open = null;
  };

  for (const line of text.split("\n")) {
    const m = HEADING.exec(line);
    if (m !== null) {
      close();
      open = { version: m[1]!, date: m[2]!, body: [] };
      continue;
    }
    // ⚠️ Any other `## ` heading ends the open section — `## [Unreleased]`, and
    // whatever a future format adds. `### ` subsections do not, and must not:
    // they are the body.
    if (line.startsWith("## ")) {
      close();
      continue;
    }
    if (open !== null) open.body.push(line);
  }
  close();

  // compareSemver takes `v`-prefixed tags; anything without the prefix sorts as
  // older than everything, which would silently scramble this order.
  return out.sort((a, b) => compareSemver(`v${a.version}`, `v${b.version}`));
}
```

- [ ] **Step 5: Export it**

`packages/deploy/src/index.ts` becomes:

```ts
export { compareSemver, selectNewestTag } from "./tags";
export { classifyChanges, type Changes } from "./changes";
export { parseChangelog, type ChangelogRelease } from "./changelog";
```

- [ ] **Step 6: Run the tests**

```bash
cd packages/deploy && npx vitest run && npx tsc --noEmit
```

Expected: all pass, no type errors.

- [ ] **Step 7: Commit**

```bash
git add packages/deploy/src/changelog.ts packages/deploy/src/index.ts packages/deploy/test/changelog.test.ts
git commit -m "feat(deploy): parse CHANGELOG.md into releases, oldest first"
```

### Task 7: The `release_announcements` table

**Files:**
- Modify: `packages/db/src/schema.ts`
- Create: `packages/db/migrations/0038_release_announcements.sql` (generated)
- Modify: `packages/db/migrations/meta/_journal.json` (generated)

**Interfaces:**
- Produces: `releaseAnnouncements` from `@factions/db`, with columns `id`, `version`, `releasedAt`, `title`, `body`, `queuedAt`, `postedAt`. Tasks 8 and 10 import it.

- [ ] **Step 1: Add the table to the schema**

Append to `packages/db/src/schema.ts`, after `vehicleWipeAnnouncements`:

```ts
/**
 * One row per released version, queued for #releases and drained by the bot.
 *
 * Written by `pnpm release:sync` alone (from `deploy/deploy-release.sh` after a
 * verified deploy, or by hand to backfill), a single statement touching no other
 * table — so it sits LAST in the lock order (spec §4.12) and can safely.
 *
 * ⚠️ This table is the only thing that prevents a re-post. Truncating it, or
 * restoring a dump taken before a release was announced, re-announces every
 * release it no longer records — the whole history, in order, into the channel.
 *
 * ⚠️ No `attempts`/`failed_at`, unlike `clan_notices`. A notice's targets are
 * independent, so a stuck one is abandoned after three tries rather than
 * blocking the rest. A release queue is the opposite: order is the point, so a
 * failure blocks and retries until a human clears it, as `war_log_events` does.
 */
export const releaseAnnouncements = pgTable("release_announcements", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  /** "1.17.0", without the leading `v` — as `CHANGELOG.md` writes it. */
  version: text("version").notNull().unique(),
  /** The date on the changelog heading, which is the tag's date. */
  releasedAt: timestamp("released_at", { withTimezone: true }).notNull(),
  /**
   * The tag's subject line. Null when the tag carried none beyond the bare
   * version — v1.16.0 and v1.17.0 were tagged that way, and post untitled.
   */
  title: text("title"),
  /** The changelog section, markdown, verbatim. */
  body: text("body").notNull(),
  queuedAt: timestamp("queued_at", { withTimezone: true }).notNull().defaultNow(),
  postedAt: timestamp("posted_at", { withTimezone: true }),
}, (t) => ({
  queue: index("release_announcements_queue_idx").on(t.id).where(sql`${t.postedAt} IS NULL`),
}));
```

`bigserial`, `text`, `timestamp`, `index` and `sql` are already imported at the top of the file.

- [ ] **Step 2: Generate the migration**

```bash
cd packages/db && npx drizzle-kit generate --name release_announcements
```

- [ ] **Step 3: Read the generated SQL**

```bash
cat packages/db/migrations/0038_release_announcements.sql
```

Expected: a single `CREATE TABLE "release_announcements"` plus the unique constraint and the partial index. **Nothing else.** If the diff contains an `ALTER` or `DROP` against any other table, stop — the local schema has drifted from the journal and that must be understood before the file goes anywhere near `factions_live`.

⚠️ CREATE only means this migration does not need the bot stopped, and the release deployer applies it in the normal course.

- [ ] **Step 4: Verify it applies**

```bash
cd packages/db && TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions" \
  TEST_DATABASE_FRESH=1 npx vitest run
```

Expected: PASS. `TEST_DATABASE_FRESH=1` drops and recreates `factions_test_db` so the new migration applies from scratch. Run `vitest` directly here, not through turbo — `turbo.json`'s `test` task does not pass `TEST_DATABASE_FRESH` to the child process.

- [ ] **Step 5: Commit**

```bash
git add packages/db/src/schema.ts packages/db/migrations/
git commit -m "feat(db): release_announcements, the release notes queue"
```

### Task 8: `pnpm release:sync`

**Files:**
- Create: `scripts/release-sync.ts`
- Modify: `package.json`

**Interfaces:**
- Consumes: `parseChangelog` from `@factions/deploy` (Task 6); `releaseAnnouncements`, `createClient` from `@factions/db` (Task 7).
- Produces: the `release:sync` script entry. Task 12 calls it from bash.

- [ ] **Step 1: Write the script**

Create `scripts/release-sync.ts`:

```ts
/**
 * Queue an announcement for every released version that does not have one.
 *
 *   DATABASE_URL=postgres://... pnpm release:sync
 *   DATABASE_URL=postgres://... pnpm release:sync --dry-run
 *
 * The backfill, the per-deploy hook and the repair tool, all one call. It is
 * idempotent: a version already in `release_announcements` is left alone, so
 * running it twice queues nothing the second time.
 *
 * ⚠️ Inserts in ASCENDING semver order, one statement at a time, because the
 * bot posts by insert id. A batch insert would leave the order to the database.
 *
 * ⚠️ Reads `CHANGELOG.md` from the working tree. Run from the checkout whose
 * release you mean to announce — `deploy-release.sh` calls it after moving the
 * tree to the new tag, so it sees the new section.
 *
 * ⚠️ Refuses a DATABASE_URL whose database is not `factions_live` unless
 * `--allow-test-db` is passed — same guard as `scripts/wipe.ts`, for the same
 * reason: the target must never be a typo.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createClient, releaseAnnouncements } from "@factions/db";
import { parseChangelog } from "@factions/deploy";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const allowTestDb = args.includes("--allow-test-db");

const url = process.env.DATABASE_URL;
if (!url) {
  throw new Error("DATABASE_URL is not set.");
}
if (!allowTestDb && !url.endsWith("/factions_live")) {
  throw new Error(
    `DATABASE_URL does not end in /factions_live (got: ${url}). ` +
      "Pass --allow-test-db to run against a non-production database.",
  );
}

const changelogPath = fileURLToPath(new URL("../CHANGELOG.md", import.meta.url));
const releases = parseChangelog(readFileSync(changelogPath, "utf8"));
if (releases.length === 0) {
  console.warn(`release:sync: no releases found in ${changelogPath}; nothing to queue.`);
  process.exit(0);
}

/**
 * The tag's subject line, or null when it carries nothing beyond the version.
 *
 * ⚠️ Never throws. A changelog section written before its tag exists is a
 * normal state during a release, and an untitled announcement is a much better
 * outcome than a deploy-time crash in the bookkeeping block.
 */
function tagSubject(version: string): string | null {
  try {
    const subject = execFileSync("git", ["tag", "-l", "--format=%(contents:subject)", `v${version}`], {
      encoding: "utf8",
      cwd: fileURLToPath(new URL("..", import.meta.url)),
    }).trim();
    if (subject === "" || subject === `v${version}`) return null;
    return subject;
  } catch {
    return null;
  }
}

const db = createClient(url);

const existing = new Set(
  (await db.select({ version: releaseAnnouncements.version }).from(releaseAnnouncements))
    .map((r) => r.version),
);

let queued = 0;
for (const release of releases) {
  if (existing.has(release.version)) continue;

  const title = tagSubject(release.version);
  if (dryRun) {
    console.log(`DRY: would queue ${release.version} — ${title ?? "(no title)"} (${release.body.length} chars)`);
    queued += 1;
    continue;
  }

  await db.insert(releaseAnnouncements).values({
    version: release.version,
    releasedAt: new Date(`${release.date}T00:00:00Z`),
    title,
    body: release.body,
  }).onConflictDoNothing({ target: releaseAnnouncements.version });
  console.log(`release:sync: queued ${release.version} — ${title ?? "(no title)"}`);
  queued += 1;
}

console.log(
  queued === 0
    ? "release:sync: nothing to queue; every release is already announced or queued."
    : `release:sync: ${queued} release(s) ${dryRun ? "would be " : ""}queued.`,
);
await db.$client.end();
process.exit(0);
```

- [ ] **Step 2: Add the script entry**

In the root `package.json` `"scripts"`, after `"raid:skip"`:

```json
    "release:sync": "tsx scripts/release-sync.ts",
```

- [ ] **Step 3: Typecheck**

```bash
pnpm typecheck:scripts
```

Expected: no errors.

- [ ] **Step 4: Prove the guard refuses a non-production URL**

```bash
DATABASE_URL="postgres://factions:factions@localhost:5434/factions" pnpm release:sync --dry-run
```

Expected: throws `DATABASE_URL does not end in /factions_live`.

- [ ] **Step 5: Prove the dry run lists every release**

```bash
DATABASE_URL="postgres://factions:factions@localhost:5434/factions_test_db" \
  pnpm release:sync --dry-run --allow-test-db
```

Expected: **23** `DRY: would queue …` lines, starting at `1.0.0` and ending at `1.17.0`, **in ascending order**. 23, not 25: `1.16.2` and `1.16.4` are `[WITHDRAWN]` in the changelog and are deliberately never announced. Two things are checked here — the ascending order, and the absence of those two.

- [ ] **Step 6: Commit**

```bash
git add scripts/release-sync.ts package.json
git commit -m "feat(scripts): pnpm release:sync queues unannounced releases"
```

### Task 9: Rendering, and the 4096 split

**Files:**
- Create: `apps/bot/src/release-text.ts`
- Test: `apps/bot/test/release-text.test.ts`

**Interfaces:**
- Produces: `releaseEmbeds(notes: ReleaseNotes): APIEmbed[]`, `EMBED_DESCRIPTION_MAX = 4096`, and `interface ReleaseNotes { version: string; title: string | null; body: string; releasedAt: Date }`.
- ⚠️ This file defines its own input type rather than importing Task 10's `QueuedRelease`. `release-tick.ts` imports `releaseEmbeds` from here, so importing back would be a cycle; `QueuedRelease` satisfies `ReleaseNotes` structurally, which is all the call site needs.

- [ ] **Step 1: Write the failing test**

Create `apps/bot/test/release-text.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { releaseEmbeds, EMBED_DESCRIPTION_MAX, type ReleaseNotes } from "../src/release-text.js";

const row = (over: Partial<ReleaseNotes> = {}): ReleaseNotes => ({
  version: "1.15.0",
  title: "automated base-zone enforcement",
  body: "### Added\n\n- A thing.\n",
  releasedAt: new Date("2026-09-15T00:00:00Z"),
  ...over,
});

describe("releaseEmbeds", () => {
  it("renders one embed for a body under the cap", () => {
    const embeds = releaseEmbeds(row());

    expect(embeds).toHaveLength(1);
    expect(embeds[0]!.title).toBe("v1.15.0 — automated base-zone enforcement");
    expect(embeds[0]!.description).toContain("- A thing.");
  });

  it("titles an untitled release with the bare version", () => {
    expect(releaseEmbeds(row({ title: null }))[0]!.title).toBe("v1.15.0");
  });

  it("does not number a single-embed release", () => {
    expect(releaseEmbeds(row())[0]!.footer).toBeUndefined();
  });

  it("splits a long body and numbers every piece", () => {
    const section = (n: number) => `### Section ${n}\n\n${"- a bullet of some length.\n".repeat(120)}`;
    const body = [section(1), section(2), section(3)].join("\n");
    expect(body.length).toBeGreaterThan(EMBED_DESCRIPTION_MAX);

    const embeds = releaseEmbeds(row({ body }));

    expect(embeds.length).toBeGreaterThan(1);
    expect(embeds.every((e) => (e.description ?? "").length <= EMBED_DESCRIPTION_MAX)).toBe(true);
    expect(embeds[0]!.footer?.text).toBe(`1/${embeds.length}`);
    expect(embeds.at(-1)!.footer?.text).toBe(`${embeds.length}/${embeds.length}`);
  });

  it("titles only the first piece, so a split release reads as one release", () => {
    const body = `### Section\n\n${"- a bullet of some length.\n".repeat(400)}`;

    const embeds = releaseEmbeds(row({ body }));

    expect(embeds.length).toBeGreaterThan(1);
    expect(embeds[0]!.title).toBe("v1.15.0 — automated base-zone enforcement");
    expect(embeds.slice(1).every((e) => e.title === undefined)).toBe(true);
  });

  it("splits a single oversized paragraph rather than dropping it", () => {
    // ⚠️ No markdown boundary to split on. Truncating here would lose release
    // notes silently, which is worse than an ugly break.
    const body = "x".repeat(EMBED_DESCRIPTION_MAX * 2 + 10);

    const embeds = releaseEmbeds(row({ body }));

    expect(embeds).toHaveLength(3);
    expect(embeds.map((e) => (e.description ?? "").length).reduce((a, b) => a + b, 0)).toBe(body.length);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
cd apps/bot && npx vitest run test/release-text.test.ts
```

Expected: FAIL — cannot resolve `../src/release-text.js`.

- [ ] **Step 3: Write the implementation**

Create `apps/bot/src/release-text.ts`:

```ts
import type { APIEmbed } from "discord.js";

/**
 * What rendering needs from a queued release.
 *
 * ⚠️ Declared here rather than imported from `release-tick.ts`, which imports
 * `releaseEmbeds` from this file. `QueuedRelease` satisfies it structurally.
 */
export interface ReleaseNotes {
  version: string;
  title: string | null;
  body: string;
  releasedAt: Date;
}

/** Discord's cap on an embed description. The only size limit in play here. */
export const EMBED_DESCRIPTION_MAX = 4096;

/** Faction-feed blue, so the release posts read as the same system. */
const COLOR = 0x5865f2;

/**
 * Split a body into pieces that each fit an embed, preferring the largest
 * markdown boundary that works: `###` sections, then paragraphs, then a hard
 * cut. A hard cut is ugly; dropping the overflow would be a silent loss.
 */
function pieces(body: string): string[] {
  const out: string[] = [];
  for (const section of body.split(/\n(?=### )/u)) {
    if (section.length <= EMBED_DESCRIPTION_MAX) {
      out.push(section);
      continue;
    }
    for (const paragraph of section.split(/\n{2,}/u)) {
      if (paragraph.length <= EMBED_DESCRIPTION_MAX) {
        out.push(paragraph);
        continue;
      }
      for (let i = 0; i < paragraph.length; i += EMBED_DESCRIPTION_MAX) {
        out.push(paragraph.slice(i, i + EMBED_DESCRIPTION_MAX));
      }
    }
  }
  return out.filter((p) => p !== "");
}

/** Greedily refill pieces into as few embeds as fit. */
function pack(parts: string[]): string[] {
  const out: string[] = [];
  let buf = "";
  for (const part of parts) {
    const next = buf === "" ? part : `${buf}\n\n${part}`;
    if (next.length <= EMBED_DESCRIPTION_MAX) {
      buf = next;
      continue;
    }
    if (buf !== "") out.push(buf);
    buf = part;
  }
  if (buf !== "") out.push(buf);
  return out;
}

/**
 * A release as the embeds to post, in order.
 *
 * ⚠️ Only the first carries the title, and every piece past the first carries
 * `n/total` — otherwise a split release reads in the channel as several
 * releases with the same version number.
 */
export function releaseEmbeds(notes: ReleaseNotes): APIEmbed[] {
  const heading = notes.title === null ? `v${notes.version}` : `v${notes.version} — ${notes.title}`;
  const bodies = notes.body.trim() === "" ? [""] : pack(pieces(notes.body.trim()));

  return bodies.map((description, i) => ({
    ...(i === 0 ? { title: heading } : {}),
    description,
    color: COLOR,
    timestamp: notes.releasedAt.toISOString(),
    ...(bodies.length > 1 ? { footer: { text: `${i + 1}/${bodies.length}` } } : {}),
  }));
}
```

- [ ] **Step 4: Run the tests**

```bash
cd apps/bot && npx vitest run test/release-text.test.ts
```

Expected: PASS, all six.

- [ ] **Step 5: Commit**

```bash
git add apps/bot/src/release-text.ts apps/bot/test/release-text.test.ts
git commit -m "feat(bot): render a release as embeds, splitting at 4096"
```

### Task 10: The release tick

**Files:**
- Create: `apps/bot/src/release-tick.ts`
- Test: `apps/bot/test/release-tick.test.ts`

**Interfaces:**
- Consumes: `releaseEmbeds` (Task 9); `releaseAnnouncements` from `@factions/db` (Task 7); `FeedPoster` from `./feed-tick.js`, which is `(embed: APIEmbed) => Promise<void>`.
- Produces: `QueuedRelease`, `ReleaseStore`, `pgReleaseStore(db: Database): ReleaseStore`, `releaseTick(store, post, opts): Promise<ReleaseTickResult>` where `ReleaseTickResult = { posted: number; blockedAt: number | null }`. Task 11 wires all of these.

- [ ] **Step 1: Write the failing test**

Create `apps/bot/test/release-tick.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import type { APIEmbed } from "discord.js";
import { releaseTick, type QueuedRelease, type ReleaseStore } from "../src/release-tick.js";

const now = new Date("2026-09-17T12:00:00Z");

const row = (id: number, over: Partial<QueuedRelease> = {}): QueuedRelease => ({
  id,
  version: `1.${id}.0`,
  title: `release ${id}`,
  body: `### Added\n\n- Thing ${id}.`,
  releasedAt: new Date("2026-09-17T00:00:00Z"),
  ...over,
});

function fakeStore(rows: QueuedRelease[]): ReleaseStore & { posted: number[] } {
  const posted: number[] = [];
  return {
    posted,
    readOldestUnposted: async () =>
      rows.filter((r) => !posted.includes(r.id)).sort((a, b) => a.id - b.id)[0] ?? null,
    markPosted: async (id) => { posted.push(id); },
  };
}

describe("releaseTick", () => {
  it("posts the oldest unposted release and marks it", async () => {
    const store = fakeStore([row(1), row(2)]);
    const post = vi.fn<(e: APIEmbed) => Promise<void>>().mockResolvedValue(undefined);

    const r = await releaseTick(store, post, { now });

    expect(r).toEqual({ posted: 1, blockedAt: null });
    expect(store.posted).toEqual([1]);
    expect(post).toHaveBeenCalledTimes(1);
    expect(post.mock.calls[0]![0]!.title).toBe("v1.1.0 — release 1");
  });

  it("posts exactly one release per tick, so a backfill is paced", async () => {
    // ⚠️ The reason this tick is not batched like warLogTick: the first run
    // after a backfill has 25 rows, and 25 messages at once is a wall.
    const store = fakeStore([row(1), row(2), row(3)]);
    const post = vi.fn<(e: APIEmbed) => Promise<void>>().mockResolvedValue(undefined);

    await releaseTick(store, post, { now });
    await releaseTick(store, post, { now });

    expect(store.posted).toEqual([1, 2]);
  });

  it("does nothing when the queue is empty", async () => {
    const store = fakeStore([]);
    const post = vi.fn<(e: APIEmbed) => Promise<void>>().mockResolvedValue(undefined);

    const r = await releaseTick(store, post, { now });

    expect(r).toEqual({ posted: 0, blockedAt: null });
    expect(post).not.toHaveBeenCalled();
  });

  it("does not mark a release posted when the post fails", async () => {
    const store = fakeStore([row(1)]);
    const post = vi.fn<(e: APIEmbed) => Promise<void>>().mockRejectedValue(new Error("discord is down"));
    const onError = vi.fn();

    const r = await releaseTick(store, post, { now, onError });

    expect(r).toEqual({ posted: 0, blockedAt: 1 });
    expect(store.posted).toEqual([]);
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it("blocks rather than skipping ahead, so the history keeps its order", async () => {
    const store = fakeStore([row(1), row(2)]);
    const post = vi.fn(async (e: APIEmbed) => {
      if (e.title?.includes("1.1.0")) throw new Error("discord is down");
    });

    await releaseTick(store, post, { now });
    await releaseTick(store, post, { now });

    expect(store.posted).toEqual([]);
  });

  it("leaves a multi-embed release unmarked when a later embed fails", async () => {
    // ⚠️ Re-posts the whole release next tick, duplicating the first embed.
    // Chosen over marking it posted, which would lose the rest permanently.
    const store = fakeStore([row(1, { body: "x".repeat(9000) })]);
    let calls = 0;
    const post = vi.fn(async () => {
      calls += 1;
      if (calls === 2) throw new Error("discord is down");
    });

    const r = await releaseTick(store, post, { now });

    expect(r.blockedAt).toBe(1);
    expect(store.posted).toEqual([]);
    expect(calls).toBe(2);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
cd apps/bot && npx vitest run test/release-tick.test.ts
```

Expected: FAIL — cannot resolve `../src/release-tick.js`.

- [ ] **Step 3: Write the implementation**

Create `apps/bot/src/release-tick.ts`:

```ts
import { asc, eq, isNull } from "drizzle-orm";
import { releaseAnnouncements, type Database } from "@factions/db";
import type { FeedPoster } from "./feed-tick.js";
import { releaseEmbeds } from "./release-text.js";

export interface QueuedRelease {
  id: number;
  version: string;
  title: string | null;
  body: string;
  releasedAt: Date;
}

export interface ReleaseStore {
  readOldestUnposted(): Promise<QueuedRelease | null>;
  markPosted(id: number, at: Date): Promise<void>;
}

export type ReleaseTickResult = {
  posted: number;
  /** The id of the row that failed, or null if nothing blocked. */
  blockedAt: number | null;
};

export function pgReleaseStore(db: Database): ReleaseStore {
  return {
    readOldestUnposted: async () => {
      const [row] = await db.select({
        id: releaseAnnouncements.id,
        version: releaseAnnouncements.version,
        title: releaseAnnouncements.title,
        body: releaseAnnouncements.body,
        releasedAt: releaseAnnouncements.releasedAt,
      })
        .from(releaseAnnouncements)
        .where(isNull(releaseAnnouncements.postedAt))
        .orderBy(asc(releaseAnnouncements.id))
        .limit(1);
      return row ?? null;
    },
    markPosted: async (id, at) => {
      await db.update(releaseAnnouncements)
        .set({ postedAt: at })
        .where(eq(releaseAnnouncements.id, id));
    },
  };
}

/**
 * Post the oldest unannounced release, one per tick.
 *
 * ⚠️ ONE row per tick, unlike `warLogTick`'s batch of 20. The first run after a
 * backfill has 25 rows behind it, and at `BOT_TICK_INTERVAL_MS` this spreads
 * them over minutes instead of dumping them into the channel at once. In steady
 * state there is never more than one row, so the pacing costs nothing.
 *
 * ⚠️ Post first, mark second, and a failure BLOCKS rather than skipping ahead —
 * the same contract as `feedTick` and `warLogTick`, for the same reason: a
 * retried older release landing below a newer one makes the channel stop being
 * a history. At-least-once, so a crash between the post and the mark re-posts.
 */
export async function releaseTick(
  store: ReleaseStore,
  post: FeedPoster,
  opts: { now: Date; onError?: (id: number, err: unknown) => void },
): Promise<ReleaseTickResult> {
  const row = await store.readOldestUnposted();
  if (row === null) return { posted: 0, blockedAt: null };

  try {
    // ⚠️ Sequential, not Promise.all: the pieces of a split release must land
    // in order, and Discord does not guarantee ordering across concurrent sends.
    for (const embed of releaseEmbeds(row)) {
      await post(embed);
    }
  } catch (err) {
    opts.onError?.(row.id, err);
    return { posted: 0, blockedAt: row.id };
  }

  await store.markPosted(row.id, opts.now);
  return { posted: 1, blockedAt: null };
}
```

- [ ] **Step 4: Run the tests**

```bash
cd apps/bot && npx vitest run test/release-tick.test.ts test/release-text.test.ts && npx tsc --noEmit
```

Expected: all pass, no type errors.

- [ ] **Step 5: Commit**

```bash
git add apps/bot/src/release-tick.ts apps/bot/test/release-tick.test.ts
git commit -m "feat(bot): drain the release queue, one release per tick"
```

### Task 11: Wire it into the bot

**Files:**
- Modify: `apps/bot/src/config.ts`
- Modify: `apps/bot/src/discord.ts`
- Modify: `apps/bot/README.md`

**Interfaces:**
- Consumes: everything from Task 10, plus `createFeedPoster(client, channelId): FeedPoster` which already exists in `discord.ts:352`.

- [ ] **Step 1: Add the config field**

In `apps/bot/src/config.ts`, beside the other optional channel ids (near `warLogChannelId`):

```ts
    releaseChannelId: optionalSnowflake(env, "RELEASE_CHANNEL_ID"),
```

No config-load refusal: unset degrades to "rows queue, nothing posts", exactly like `WAR_LOG_CHANNEL_ID`. It is not fatal because a bot with no release channel is not misconfigured — it is a bot that does not announce releases.

- [ ] **Step 2: Import and build the poster**

In `apps/bot/src/discord.ts`, beside the other tick imports:

```ts
import { releaseTick, pgReleaseStore } from "./release-tick.js";
```

Beside the other posters (near line 510):

```ts
  const releasePoster = cfg.releaseChannelId ? createFeedPoster(client, cfg.releaseChannelId) : null;
  const releaseStore = pgReleaseStore(db);
```

And beside the other blocked-id trackers:

```ts
  let lastReportedReleaseBlockedAt: number | null = null;
```

- [ ] **Step 3: Add the tick block**

Immediately **after** the `warLogPoster` block in the tick body, and before the kill-feed block:

```ts
    // ⚠️ After the war log, among the posters — it is a poster, not a consumer,
    // and it depends on nothing the other ticks produce. Gated on a channel id
    // the same way: unset means rows queue and nothing posts.
    if (releasePoster) {
      try {
        const r = await releaseTick(releaseStore, releasePoster, {
          now: new Date(),
          onError: (id, err) => {
            if (id === lastReportedReleaseBlockedAt) return;
            console.error(`release post failed for release_announcements row ${id}`, err);
          },
        });
        if (r.posted > 0) console.log(`release posted ${r.posted}`);
        if (r.blockedAt !== null && r.blockedAt !== lastReportedReleaseBlockedAt) {
          console.error(
            `release queue blocked at release_announcements row ${r.blockedAt}; nothing behind it will ` +
            `post until this row succeeds. Check the bot's View Channel / Send Messages permission ` +
            `on ${cfg.releaseChannelId}.`,
          );
          lastReportedReleaseBlockedAt = r.blockedAt;
        }
        if (r.blockedAt === null) lastReportedReleaseBlockedAt = null;
      } catch (err) {
        console.error("release tick failed", err);
      }
    }
```

- [ ] **Step 4: Add the startup warn**

Beside the `WAR_LOG_CHANNEL_ID` warn near line 1328:

```ts
    if (!cfg.releaseChannelId) {
      console.warn(
        "RELEASE_CHANNEL_ID is unset: release notes queue but nothing posts. " +
        "⚠️ They will ALL post, oldest first, when a channel is configured.",
      );
    }
```

⚠️ The second sentence is the point of the warning. An operator setting the channel months later gets the whole backlog at once, and this line is the only warning they get.

- [ ] **Step 5: Document the env var**

In `apps/bot/README.md`'s env table, after the `WAR_LOG_CHANNEL_ID` row:

```markdown
| `RELEASE_CHANNEL_ID` | no (unset means release notes are off) | The Discord channel release notes post to, one message per release, oldest first (`release_announcements`). Rows are queued by `pnpm release:sync`, which `deploy/deploy-release.sh` runs after a verified deploy. Unset by default: rows still accumulate, nothing posts — and ⚠️ they all post at once when a channel is first configured. The bot needs **View Channel and Send Messages** in that channel. |
```

And in the `.env` sample block further down:

```
RELEASE_CHANNEL_ID=1549900456078090260
```

- [ ] **Step 6: Typecheck and run the bot suite**

```bash
cd apps/bot && npx tsc --noEmit && TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions" npx vitest run
```

Expected: PASS. ⚠️ Do not run this while a `turbo run test` is going — they share `factions_test_bot`.

- [ ] **Step 7: Commit**

```bash
git add apps/bot/src/config.ts apps/bot/src/discord.ts apps/bot/README.md
git commit -m "feat(bot): post release notes to RELEASE_CHANNEL_ID"
```

### Task 12: The deployer hook

**Files:**
- Modify: `deploy/deploy-release.sh`

- [ ] **Step 1: Find the bookkeeping block**

```bash
grep -n 'trap - ERR' deploy/deploy-release.sh
grep -n 'alert "DEPLOYED"' deploy/deploy-release.sh
```

The insertion point is between them — after `trap - ERR`, after the `state_write` and marker lines, immediately before `alert "DEPLOYED"`.

- [ ] **Step 2: Insert the call**

```sh
  # ⚠️ Below the disarm, with the rest of the bookkeeping, and NEVER above it.
  # Past that line the release is verified healthy and the bot is live; a failed
  # announcement is worth an alert and a re-run, never a rollback that would drop
  # and restore factions_live out from under a working release. Same reasoning as
  # the state_write above.
  #
  # ⚠️ Idempotent and cheap: release:sync queues only versions that have no row,
  # so a re-run after a failure announces exactly what was missed and nothing else.
  # It reads CHANGELOG.md from the tree this deploy just moved to "$TAG", which is
  # why it runs here and not before the checkout.
  run "$PNPM" release:sync \
    || alert "CRITICAL" "$TAG is live but its release notes were not queued; run 'pnpm release:sync' in $REPO"
```

- [ ] **Step 3: Check the script still parses**

```bash
bash -n deploy/deploy-release.sh && echo "syntax ok"
```

Expected: `syntax ok`.

- [ ] **Step 4: Confirm it is dry-run safe and correctly placed**

A full `--dry-run` needs the production host's layout, so verify by reading:

```bash
sed -n "/trap - ERR/,/alert \"DEPLOYED\"/p" deploy/deploy-release.sh
```

Two things must be true in that output, and both are silent failures if they are not:
1. The call goes through `run`, so `--dry-run` prints `DRY: … pnpm release:sync` and executes nothing.
2. It sits inside the `else` branch of the `if [ "$DRY_RUN" = "1" ]` block that already guards the health checks — outside it, a dry run would reach the database.

- [ ] **Step 5: Commit**

```bash
git add deploy/deploy-release.sh
git commit -m "feat(deploy): queue the release notes after a verified deploy"
```

### Task 13: Runbook, CLAUDE.md, changelog, PR

**Files:**
- Create: `docs/deploy/2026-09-17-release-announcements.md`
- Modify: `CLAUDE.md`
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Write the runbook**

Create `docs/deploy/2026-09-17-release-announcements.md` covering, in order:

1. **What this is** — one paragraph, and a pointer to the spec.
2. **Prerequisite:** migration 0038 has applied. Check with
   `docker exec clan-wars-postgres-1 psql -U factions -d factions_live -X -c "\d release_announcements"`.
   CREATE only, so the deployer applies it in the normal course and the bot does not need stopping.
3. **Enable:** add `RELEASE_CHANNEL_ID=1549900456078090260` to `/opt/clan-wars/.env`, then
   `sudo systemctl restart clan-wars-bot`. Confirm with
   `journalctl -u clan-wars-bot --since "2 min ago" | grep -i release` — the
   `RELEASE_CHANNEL_ID is unset` warn must be **gone**.
4. **Backfill:** `cd /opt/clan-wars && pnpm release:sync --dry-run`, read the 23
   lines and check they ascend from 1.0.0 and that `1.16.2`/`1.16.4` are absent,
   then `pnpm release:sync`.
5. **Watch:** one message about every 10 s for roughly four minutes (23, not 25).
   `psql -c "select count(*) from release_announcements where posted_at is null"`
   should reach 0.
6. **If it blocks:** the bot logs `release queue blocked at release_announcements row N`
   at error level and nothing behind it posts. Almost always the bot lacking
   **View Channel** or **Send Messages** on the channel. Fix the permission; the
   next tick retries by itself. Nothing needs restarting.
7. **⚠️ Hazards**, verbatim from the spec §3.2 and §5: truncating the table or
   restoring an older dump re-announces everything; steps 3 and 4 belong
   together; a version with no changelog section is never announced, and
   `release:sync --dry-run` is how you find one.
8. **Suppressing one release:** mark its heading
   `## [X.Y.Z] - YYYY-MM-DD [WITHDRAWN]` and it is never announced — the same
   marker v1.16.2 and v1.16.4 already carry. ⚠️ It only works BEFORE
   `release:sync` has queued that version; once a row exists, the marker does
   nothing and the row must be deleted by hand.
9. **Rollback:** unset `RELEASE_CHANNEL_ID` and restart. Rows keep queuing and
   nothing posts. Nothing already posted is retracted.

- [ ] **Step 2: Add the CLAUDE.md "Where things live" row**

In the table, after the weekly vehicle rotation row:

```markdown
| Release notes in Discord | `CHANGELOG.md` is the source; parsed by `parseChangelog` in `packages/deploy/src/changelog.ts`, queued into `release_announcements` by `pnpm release:sync` (`scripts/release-sync.ts`, called by `deploy/deploy-release.sh` after a verified deploy), rendered by `apps/bot/src/release-text.ts` and posted one per tick by `apps/bot/src/release-tick.ts`. Gated on `RELEASE_CHANNEL_ID`. ⚠️ The table is the ONLY thing preventing a re-post — truncating it, or restoring a dump from before a release was announced, re-announces the whole history into the channel. ⚠️ A version with no `## [x.y.z] - DATE` section is never announced, silently; `pnpm release:sync --dry-run` is the check. ⚠️ A heading suffixed `[WITHDRAWN]` is deliberately never announced — that is the ONLY per-release opt-out, it is the anchored `$` in `HEADING` that enforces it, and it works only before `release:sync` has queued that version. Runbook `docs/deploy/2026-09-17-release-announcements.md` |
```

- [ ] **Step 3: Add the table to the lock order**

In the "Lock order (spec §4.12)" bullet, extend the final list with `→ release_announcements`, and add to the paragraph that already excuses `server_restarts` and `vehicle_wipe_announcements`:

```markdown
`release_announcements` is outside the order for the same reason: written by
`release:sync` alone, one statement, touching no other table.
```

- [ ] **Step 4: Add the changelog entry**

Replace the design-only `Unreleased` bullet added by the spec commit with:

```markdown
- Every release announces itself in Discord. `CHANGELOG.md` is the source:
  `deploy-release.sh` queues a row after a **verified** deploy (not on the tag
  push — a deploy can roll back), and the bot posts one release per tick,
  oldest first, stopping at the first failure so the channel stays a history.
  `pnpm release:sync` is the backfill, the per-deploy hook and the repair tool,
  all one idempotent call. Migration 0038 adds `release_announcements`, CREATE
  only. Off until `RELEASE_CHANNEL_ID` is set — ⚠️ and everything queued posts
  at once when it is. Runbook:
  `docs/deploy/2026-09-17-release-announcements.md`.
```

- [ ] **Step 5: Run the full gate**

```bash
TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions" \
  npx turbo run typecheck test --concurrency=1 --force
```

Expected: **30/30 tasks**, all passing. Count the tasks; a cached pass proves nothing. Make sure no other `turbo run test` or `vitest` is running at the same time.

- [ ] **Step 6: Commit and open the PR**

```bash
git add docs/deploy/2026-09-17-release-announcements.md CLAUDE.md CHANGELOG.md
git commit -m "docs: runbook and notes for release announcements"
```

Then the `keel:finish-work` skill. Base is `main`.

---

## Deployment

After PR 2 lands, `clan-wars-deploy.timer` picks up the next release tag and applies 0038 in the normal course. Then follow `docs/deploy/2026-09-17-release-announcements.md` steps 3–5 on the host: set `RELEASE_CHANNEL_ID`, restart the bot, `pnpm release:sync --dry-run`, `pnpm release:sync`, watch.

⚠️ The release that carries this change announces **itself** as part of the backfill, since `release:sync` queues every version in the changelog including the current one.
