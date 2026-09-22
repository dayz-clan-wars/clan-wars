# Discord Message Consistency — Implementation Plan (increment 1)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every message the bot sends states time with Discord `<t:…>` tokens, links clan names and gamertags to the site, posts to the right channel, and matches the brand guide.

**Architecture:** Two new pure modules — `@factions/copy`'s `discord-time.ts` (token builders) and `apps/bot`'s `site-links.ts` (URL builders kept separate from link renderers) — then every message module is rewritten to call them. The raid window and weekly vehicle wipe move from `ANNOUNCEMENTS_CHANNEL_ID` to the existing shared `serverEventsPoster`, and `announcementsChannelId` leaves the bot's config entirely.

**Tech Stack:** TypeScript, pnpm workspace + turbo, vitest, discord.js.

**Spec:** `docs/superpowers/specs/2026-09-21-discord-message-consistency-design.md`
**Audit (per-message table):** `docs/superpowers/specs/2026-09-21-discord-message-audit.md`

**Scope:** This plan is **increment 1 only** — what messages *say*. Increment 2 (converting the feed-shaped surfaces to embeds, §5 of the spec) is a separate plan written after this one ships. Increment 1 is a complete, shippable deliverable on its own.

## Global Constraints

- **Link form is `[text](<url>)`** — angle brackets inside the masked link. Verified live; they suppress Discord's OpenGraph unfurl.
- **URL builders return bare URLs; link *renderers* add the angle brackets.** `embed.setURL()` rejects `<https://…>`.
- **`@factions/copy` may never emit `<t:`** in a string reachable from its copy tables. The website renders those same strings.
- **Numbers are interpolated from `@factions/domain`, never typed into copy** (brand principle 2).
- **No exclamation marks, no emoji added.** Em dashes, spaced en dashes and `·` are all in use — `brand/02-verbal-identity.md` is the authority.
- **Durations stay literal numbers** (`24h`, `7 days`, `3h 15m`). Only *instants* become tokens.
- **Ephemeral replies stay ephemeral** — `command-registration.test.ts` enforces it.
- **Do not run two test invocations at once.** `factions_test_<package>` is derived from the package name alone; a concurrent run produces failures that look exactly like real regressions.
- **The gate:** `TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions" npx turbo run typecheck test --concurrency=1 --force` — expect **30/30 tasks**. Check the count, not the exit code.
- **Branch first.** `main` is protected. Use `keel:start-work`; every PR needs a committed `## [Unreleased]` entry in `CHANGELOG.md`.

---

## File Structure

**Created:**

| File | Responsibility |
|---|---|
| `packages/copy/src/discord-time.ts` | `at`/`rel`/`atRel` token builders, NaN-guarded |
| `packages/copy/test/discord-time.test.ts` | Their tests |
| `packages/copy/test/no-discord-tokens.test.ts` | The invariant: no copy-table string contains `<t:` |
| `apps/bot/src/site-links.ts` | `profileUrl`/`clanUrl` (bare) + `playerLink`/`clanLink`/`who` (rendered) |
| `apps/bot/test/site-links.test.ts` | Their tests |

**Modified:** `packages/copy/src/{index,base,link}.ts`; `apps/bot/src/{raid-window-text,announce-text,airdrop-text,war-log-text,ban-announce-text,notice-text,notice-tick,feed-embed,online-embed,kill-feed-embed,dormancy-notify,ceremony-notify,achievement-embed,leaderboard-embed,config,discord}.ts`; `apps/bot/src/commands/embeds/*.ts`; three `docs/deploy/*.md`; `brand/02-verbal-identity.md`; `CLAUDE.md`; `CHANGELOG.md`.

---

## Task 0: Branch, and settle the one unverified assumption

**Files:** none yet (a scratch Discord post, then deleted)

**Interfaces:**
- Produces: a yes/no on whether `<t:…>` renders in an embed **field name**. Tasks 10 and 11 read it.

Spec §4.1. Rows 47 (`/alphas`) and 58 (`/found`) depend on this and guessing wrong puts a literal `<t:1234:F>` on a player's card.

- [ ] **Step 1: Create the branch**

```bash
# Use the keel:start-work skill. It picks the branch name and base.
```

- [ ] **Step 2: Post the probe to #server-events**

Run on the prod host (`acab@regime.fi`). A `User-Agent` header is **mandatory** — Discord sits behind Cloudflare, which rejects Python `urllib`'s default UA with `error code: 1010` and an HTTP 403 that looks exactly like a permissions problem.

```python
import json, time, urllib.request

env = {}
for line in open("/opt/clan-wars/.env"):
    line = line.strip()
    if line and not line.startswith("#") and "=" in line:
        k, v = line.split("=", 1)
        env[k] = v.strip().strip('"').strip("'")

soon = int(time.time()) + 3 * 3600
payload = {
    "embeds": [{
        "color": 0xc8a34a,
        "fields": [
            {"name": "Field name with a token: <t:%d:F>" % soon, "value": "If the NAME above shows a date, tokens render in field names."},
            {"name": "Field value with a token", "value": "Value token: <t:%d:F> and relative <t:%d:R>" % (soon, soon)},
        ],
    }],
    "allowed_mentions": {"parse": []},
}
req = urllib.request.Request(
    "https://discord.com/api/v10/channels/%s/messages" % env["SERVER_EVENTS_CHANNEL_ID"],
    data=json.dumps(payload).encode(),
    headers={
        "Authorization": "Bot " + env["DISCORD_TOKEN"],
        "Content-Type": "application/json",
        "User-Agent": "DiscordBot (https://dayzclanwars.com, 1.0)",
    },
    method="POST",
)
with urllib.request.urlopen(req) as r:
    print(json.load(r)["id"])
```

- [ ] **Step 3: Look at it in Discord and record the answer**

Expected (high confidence): the **value** renders a formatted date; the **name** shows the literal `<t:…:F>`.

Write the answer into the audit file next to rows 47 and 58 so the later tasks do not re-litigate it.

- [ ] **Step 4: Delete the probe message**

```python
# Same env-loading and headers as Step 2.
req = urllib.request.Request(
    "https://discord.com/api/v10/channels/%s/messages/%s" % (env["SERVER_EVENTS_CHANNEL_ID"], MESSAGE_ID),
    headers={"Authorization": "Bot " + env["DISCORD_TOKEN"], "User-Agent": "DiscordBot (https://dayzclanwars.com, 1.0)"},
    method="DELETE",
)
urllib.request.urlopen(req)
```

- [ ] **Step 5: Commit the two spec documents onto the branch**

```bash
git add docs/superpowers/specs/2026-09-21-discord-message-audit.md \
        docs/superpowers/specs/2026-09-21-discord-message-consistency-design.md \
        docs/superpowers/plans/2026-09-21-discord-message-consistency.md
git commit -m "docs: Discord message audit, design and plan"
```

---

## Task 1: `discord-time.ts`

**Files:**
- Create: `packages/copy/src/discord-time.ts`
- Create: `packages/copy/test/discord-time.test.ts`
- Modify: `packages/copy/src/index.ts`

**Interfaces:**
- Produces: `at(d: Date): string | null`, `rel(d: Date): string | null`, `atRel(d: Date): string | null`. Every later task consumes these.

- [ ] **Step 1: Write the failing test**

`packages/copy/test/discord-time.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { at, rel, atRel } from "../src/index";

/**
 * ⚠️ The invalid-date cases are the reason this module exists. Before it,
 * only feed-embed.ts guarded against NaN; the other five call sites would
 * have posted a literal `<t:NaN:R>` into a public channel permanently,
 * because nothing reposts. `null` rather than a fallback string is
 * deliberate: each caller already has a degrade it chose.
 */
describe("discord-time", () => {
  const d = new Date("2026-09-21T14:30:00.000Z"); // 1790001000

  it("renders the full style", () => {
    expect(at(d)).toBe("<t:1790001000:F>");
  });

  it("renders the relative style", () => {
    expect(rel(d)).toBe("<t:1790001000:R>");
  });

  it("renders both, full first", () => {
    expect(atRel(d)).toBe("<t:1790001000:F> (<t:1790001000:R>)");
  });

  it("floors to whole seconds rather than rounding", () => {
    expect(at(new Date("2026-09-21T14:30:00.999Z"))).toBe("<t:1790001000:F>");
  });

  it("handles instants before the epoch", () => {
    expect(rel(new Date("1969-12-31T23:59:59.000Z"))).toBe("<t:-1:R>");
  });

  it.each([
    ["at", at],
    ["rel", rel],
    ["atRel", atRel],
  ])("%s returns null for an invalid date", (_name, fn) => {
    expect(fn(new Date("not a date"))).toBeNull();
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
cd packages/copy && npx vitest run test/discord-time.test.ts
```

Expected: FAIL — `at`, `rel`, `atRel` are not exported from `../src/index`.

- [ ] **Step 3: Write the implementation**

`packages/copy/src/discord-time.ts`:

```ts
/**
 * Discord's timestamp tokens. `<t:…:F>` is a full date and time, `<t:…:R>`
 * a live countdown; both render in each READER's timezone, which is the
 * whole reason a posted message stays correct without an edit.
 *
 * ⚠️ Every builder returns `null` for an unrepresentable instant rather
 * than throwing or substituting a fallback. Before this module the guard
 * existed in exactly one of six call sites (`feed-embed.ts`), whose comment
 * states the stake: a payload off an unvalidated jsonb column posts a
 * literal `<t:NaN:R>` into a public channel, permanently, because nothing
 * reposts. `null` puts the choice of degrade back where it belongs — the
 * caller already has one, and a shared helper must not overrule it.
 *
 * ⚠️ This file may be imported by the bot only. It is in @factions/copy
 * because the copy split (`lapsedCopy`, `link.ts`) has one foot on each
 * surface — but NOTHING reachable from the copy TABLES may emit a token,
 * or the website renders it as literal angle-bracket noise. That is held
 * by test/no-discord-tokens.test.ts.
 */

/** Whole seconds since the epoch, floored, or null if the date is invalid. */
function epoch(d: Date): number | null {
  const ms = d.getTime();
  if (!Number.isFinite(ms)) return null;
  // ⚠️ Math.floor, not Math.round: rounding 14:30:00.999 up to :01 makes a
  // deadline render one second later than the instant it actually is.
  // Flooring is also what every hand-rolled call site this replaces did.
  return Math.floor(ms / 1000);
}

/** `<t:…:F>` — a full date and time. For a deadline whose date matters. */
export function at(d: Date): string | null {
  const s = epoch(d);
  return s === null ? null : `<t:${s}:F>`;
}

/** `<t:…:R>` — a live countdown. For an instant whose distance matters. */
export function rel(d: Date): string | null {
  const s = epoch(d);
  return s === null ? null : `<t:${s}:R>`;
}

/** `<t:…:F> (<t:…:R>)` — the date to plan around and the countdown to feel. */
export function atRel(d: Date): string | null {
  const s = epoch(d);
  return s === null ? null : `<t:${s}:F> (<t:${s}:R>)`;
}
```

- [ ] **Step 4: Export them**

In `packages/copy/src/index.ts`, beside the existing `export { days, hours, when } from "./format";`:

```ts
export { at, rel, atRel } from "./discord-time";
```

- [ ] **Step 5: Run the test and watch it pass**

```bash
cd packages/copy && npx vitest run test/discord-time.test.ts
```

Expected: PASS, 8 tests.

- [ ] **Step 6: Commit**

```bash
git add packages/copy/src/discord-time.ts packages/copy/src/index.ts packages/copy/test/discord-time.test.ts
git commit -m "feat(copy): add Discord timestamp token builders"
```

---

## Task 2: The `@factions/copy` shared-surface invariant

**Files:**
- Create: `packages/copy/test/no-discord-tokens.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: nothing importable. This is a guard, in the house style of `overrides.test.ts`.

Spec §2.3. Without this, a future edit leaks a Discord token onto the website and nobody notices until a player reads `<t:1790001000:F>` on a page.

- [ ] **Step 1: Write the test**

`packages/copy/test/no-discord-tokens.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import {
  TABLES, VAULT_TABLES, LEADERSHIP_TABLES,
  DISCORD_OVERRIDES, DISCORD_VAULT_OVERRIDES, DISCORD_LEADERSHIP_OVERRIDES,
  REFUSAL, DECLARE_COPY, RELEASE_COPY, DECLARED_OK, DISBAND_WARNING,
  ISSUE_COPY, ENDED_COPY, UNLINK_COPY, PIN_RESULT_COPY,
  EMPTY_SCOREBOARD, NO_ALPHAS_WEEK, NO_SEASONS, EMPTY_WAR_LOG, ALPHA_BADGE,
  BOARD_LABELS, EMPTY_BOARD, ACHIEVEMENT_CLOSEST, ACHIEVEMENT_NONE, NO_PROFILE,
  VAULT_INTRO, CLAIM_REFUSAL, PIN_ICON_LABELS,
} from "../src/index";

/**
 * ⚠️ @factions/copy is read by apps/web AND apps/bot. A Discord timestamp
 * token in a shared string renders as a formatted date in Discord and as
 * literal angle-bracket noise on the website.
 *
 * `discord-time.ts` deliberately lives in this package (the bot imports it
 * from here), so "the package contains no tokens" is NOT the invariant and
 * would be false. The invariant is narrower and is the one that matters:
 * nothing reachable from the COPY TABLES may contain one. A time-bearing
 * shared string takes a pre-formatted argument instead — see `lapsedCopy`.
 */
function strings(v: unknown, out: string[] = []): string[] {
  if (typeof v === "string") out.push(v);
  else if (typeof v === "function") {
    // Not called: a renderer's arguments are surface-specific by design.
    // Its SOURCE is checked instead, which catches a token typed into a
    // template literal — the only way one could get in here.
    out.push(String(v));
  } else if (Array.isArray(v)) for (const x of v) strings(x, out);
  else if (v && typeof v === "object") for (const x of Object.values(v)) strings(x, out);
  return out;
}

const SURFACES: Record<string, unknown> = {
  TABLES, VAULT_TABLES, LEADERSHIP_TABLES,
  DISCORD_OVERRIDES, DISCORD_VAULT_OVERRIDES, DISCORD_LEADERSHIP_OVERRIDES,
  REFUSAL, DECLARE_COPY, RELEASE_COPY, DECLARED_OK, DISBAND_WARNING,
  ISSUE_COPY, ENDED_COPY, UNLINK_COPY, PIN_RESULT_COPY,
  EMPTY_SCOREBOARD, NO_ALPHAS_WEEK, NO_SEASONS, EMPTY_WAR_LOG, ALPHA_BADGE,
  BOARD_LABELS, EMPTY_BOARD, ACHIEVEMENT_CLOSEST, ACHIEVEMENT_NONE, NO_PROFILE,
  VAULT_INTRO, CLAIM_REFUSAL, PIN_ICON_LABELS,
};

describe("no Discord tokens in shared copy", () => {
  it.each(Object.keys(SURFACES))("%s contains no <t: token", (name) => {
    const offenders = strings(SURFACES[name]).filter((s) => s.includes("<t:"));
    expect(offenders).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it**

```bash
cd packages/copy && npx vitest run test/no-discord-tokens.test.ts
```

Expected: PASS immediately — nothing violates it yet. That is correct for a guard: it exists to fail on a *future* edit.

- [ ] **Step 3: Prove the guard actually bites**

Temporarily add `<t:1:R>` to `DECLARED_OK` in `packages/copy/src/base.ts`, re-run, confirm FAIL, then revert. Do not commit the temporary edit.

- [ ] **Step 4: Commit**

```bash
git add packages/copy/test/no-discord-tokens.test.ts
git commit -m "test(copy): forbid Discord tokens in strings the website also renders"
```

---

## Task 3: Split the two shared strings that carry an instant

**Files:**
- Modify: `packages/copy/src/base.ts` (`lapsedCopy`)
- Modify: `packages/copy/src/link.ts` (`ISSUE_COPY["held-by-other"]`, private `at`)
- Modify: `apps/bot/src/commands/embeds/base.ts`, `apps/bot/src/commands/embeds/link.ts`
- Modify: the web callers (find with the grep in Step 2)

**Interfaces:**
- Consumes: `rel` from Task 1.
- Produces: `lapsedCopy(when: string): string` and `ISSUE_COPY["held-by-other"](o, when: string)`. Callers pass a pre-formatted string.

Spec §2.3. These are the only two shared strings that interpolate an instant rather than a duration.

- [ ] **Step 1: Write the failing test**

Add to `packages/copy/test/no-discord-tokens.test.ts`:

```ts
import { lapsedCopy } from "../src/index";

describe("time-bearing shared copy takes a pre-formatted string", () => {
  it("lapsedCopy interpolates whatever the surface formatted", () => {
    expect(lapsedCopy("<t:1790001000:R>")).toContain("<t:1790001000:R>");
    expect(lapsedCopy("21 Sep, 14:30 UTC")).toContain("21 Sep, 14:30 UTC");
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
cd packages/copy && npx vitest run test/no-discord-tokens.test.ts
```

Expected: FAIL — `lapsedCopy` currently takes a `Date` and calls `when()` itself, so passing a string produces `Invalid Date`.

- [ ] **Step 3: Change `lapsedCopy`**

In `packages/copy/src/base.ts`, replace:

```ts
/** Shown when a solo declaration has lapsed but is still inside its grace. */
export const lapsedCopy = (at: Date) =>
  `Your declaration lapsed ${when(at)} — no raise in ${days(SOLO_LAPSE_MS)}. Raise your flag at the pole and declare it again below before it goes public.`;
```

with:

```ts
/**
 * Shown when a solo declaration has lapsed but is still inside its grace.
 *
 * ⚠️ Takes the FORMATTED instant, not a Date. This string is rendered by
 * the website and by the bot, and the two format an instant differently on
 * purpose: Discord gets a `<t:…:R>` token that counts down in the reader's
 * own timezone, the site gets `when()`'s `9 Sep … UTC`. Formatting here
 * would force one of them to be wrong — and a token on the site renders as
 * literal angle-bracket noise (test/no-discord-tokens.test.ts).
 */
export const lapsedCopy = (lapsedWhen: string) =>
  `Your declaration lapsed ${lapsedWhen} — no raise in ${days(SOLO_LAPSE_MS)}. Raise your flag at the pole and declare it again below before it goes public.`;
```

If `when` is now unused in `base.ts`, drop it from the import.

- [ ] **Step 4: Change `held-by-other`**

In `packages/copy/src/link.ts`, replace the `held-by-other` entry:

```ts
  "held-by-other": (o) => `Someone else is verifying ${name(o)} right now, so a challenge cannot be issued for that character yet. Their attempt ends ${o.kind === "held-by-other" ? at(o.expiresAt) : ""}. If that character is yours, ask an admin.`,
```

with a two-argument form:

```ts
  // ⚠️ Second argument is the FORMATTED instant — same reason as lapsedCopy
  // in base.ts. The bot passes rel(), the site passes its own formatter.
  "held-by-other": (o, endsWhen = "") => `Someone else is verifying ${name(o)} right now, so a challenge cannot be issued for that character yet. Their attempt ends ${endsWhen}. If that character is yours, ask an admin.`,
```

Widen the table's type so every entry accepts the optional second argument:

```ts
export const ISSUE_COPY: Record<IssueOutcomeKind, (o: IssueOutcome, endsWhen?: string) => string> = {
```

Delete the now-unused private `at()` helper at the bottom of the file.

- [ ] **Step 5: Update every caller**

```bash
grep -rn "lapsedCopy\|ISSUE_COPY" apps packages --include="*.ts" --include="*.tsx" | grep -v node_modules
```

The bot passes `rel(d) ?? when(d)` — the `?? when(d)` arm is what preserves the caller's existing degrade when the date is unrepresentable. The website passes `when(d)`.

- [ ] **Step 6: Run the copy and bot suites**

```bash
cd packages/copy && npx vitest run
cd ../../apps/bot && npx vitest run test/
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/copy apps/bot apps/web
git commit -m "refactor(copy): time-bearing shared strings take a formatted instant"
```

---

## Task 4: `site-links.ts`

**Files:**
- Create: `apps/bot/src/site-links.ts`
- Create: `apps/bot/test/site-links.test.ts`
- Modify: `apps/bot/src/kill-feed-embed.ts` (move code out, re-export)

**Interfaces:**
- Produces:
  - `profileUrl(siteBaseUrl: string, gamertag: string): string` — bare
  - `clanUrl(siteBaseUrl: string, tag: string): string` — bare
  - `playerLink(siteBaseUrl: string, gamertag: string): string` — `[Name](<url>)`
  - `clanLink(siteBaseUrl: string, tag: string, name?: string): string`
  - `who(side: KillFeedSide, siteBaseUrl: string): string`
  - `escapeMarkdown(s: string): string` (moved)

- [ ] **Step 1: Write the failing test**

`apps/bot/test/site-links.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { profileUrl, clanUrl, playerLink, clanLink } from "../src/site-links.js";

const SITE = "https://dayzclanwars.com";

describe("site-links", () => {
  /**
   * ⚠️ The bare/rendered split is the point of this module. embed.setURL()
   * rejects `<https://…>`, and inline text needs the angle brackets or
   * Discord unfurls an OpenGraph card under every line. Builders bare,
   * renderers wrapped, so no call site can get it wrong.
   */
  it("builds bare URLs", () => {
    expect(profileUrl(SITE, "SomePlayer")).toBe("https://dayzclanwars.com/players/SomePlayer");
    expect(clanUrl(SITE, "NOMAD")).toBe("https://dayzclanwars.com/clans/NOMAD");
  });

  it("URL-encodes a gamertag with a space", () => {
    expect(profileUrl(SITE, "Some Player")).toBe("https://dayzclanwars.com/players/Some%20Player");
  });

  it("wraps rendered links in angle brackets to suppress the unfurl", () => {
    expect(playerLink(SITE, "SomePlayer"))
      .toBe("[SomePlayer](<https://dayzclanwars.com/players/SomePlayer>)");
  });

  it("escapes markdown in the label but not in the URL", () => {
    // A gamertag is player-controlled text; markdown in it would restyle the line.
    expect(playerLink(SITE, "a_b*c"))
      .toBe("[a\\_b\\*c](<https://dayzclanwars.com/players/a_b*c>)");
  });

  it("renders a clan with a name as bold name plus plain tag", () => {
    expect(clanLink(SITE, "NOMAD", "Nomads"))
      .toBe("**[Nomads](<https://dayzclanwars.com/clans/NOMAD>)** [NOMAD]");
  });

  it("renders a clan without a name as the linked tag alone", () => {
    expect(clanLink(SITE, "NOMAD")).toBe("[NOMAD](<https://dayzclanwars.com/clans/NOMAD>)");
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
cd apps/bot && npx vitest run test/site-links.test.ts
```

Expected: FAIL — `../src/site-links.js` does not exist.

- [ ] **Step 3: Write the module**

`apps/bot/src/site-links.ts`:

```ts
import type { KillFeedSide } from "./kill-feed-embed.js";

/** Discord markdown in a gamertag would restyle the line; a name is text, never markup. */
export function escapeMarkdown(s: string): string {
  return s.replace(/[\\*_~`|[\]()>]/gu, (c) => `\\${c}`);
}

/**
 * ⚠️ BARE URLs. These feed `embed.setURL()` and `embed.thumbnail.url`,
 * which reject `<https://…>` outright. The angle brackets that suppress
 * Discord's OpenGraph unfurl belong to the RENDERERS below, not here —
 * putting them in one place is what stops a call site getting it wrong.
 */
export function profileUrl(siteBaseUrl: string, gamertag: string): string {
  return `${siteBaseUrl}/players/${encodeURIComponent(gamertag)}`;
}

export function clanUrl(siteBaseUrl: string, tag: string): string {
  return `${siteBaseUrl}/clans/${encodeURIComponent(tag)}`;
}

/**
 * ⚠️ `[text](<url>)` — the angle brackets are load-bearing, not styling.
 * Without them Discord unfurls an OpenGraph preview card beneath the
 * message, which would put a site card under every war-log line. Verified
 * live 2026-09-21; `flags: 4` (SUPPRESS_EMBEDS) also works but suppresses
 * embeds we send ourselves, so it is not usable here.
 */
export function playerLink(siteBaseUrl: string, gamertag: string): string {
  return `[${escapeMarkdown(gamertag)}](<${profileUrl(siteBaseUrl, gamertag)}>)`;
}

/**
 * With a name: `**[Name](<url>)** [TAG]` — the house form, bold actor plus
 * plain tag. Without one: the linked tag alone, for the tag that sits
 * beside an already-linked gamertag in the feeds.
 */
export function clanLink(siteBaseUrl: string, tag: string, name?: string): string {
  const url = clanUrl(siteBaseUrl, tag);
  if (name === undefined) return `[${escapeMarkdown(tag)}](<${url}>)`;
  return `**[${escapeMarkdown(name)}](<${url}>)** [${escapeMarkdown(tag)}]`;
}

/** `[Name](<profile>)` in bold, then the clan tag — now linked too. */
export function who(side: KillFeedSide, siteBaseUrl: string): string {
  const name = `**${playerLink(siteBaseUrl, side.gamertag)}**`;
  return side.tag ? `${name} [${clanLink(siteBaseUrl, side.tag)}]` : name;
}
```

- [ ] **Step 4: Gut `kill-feed-embed.ts` and re-export**

Delete `escapeMarkdown`, `profileUrl` and `who` from `apps/bot/src/kill-feed-embed.ts`. Add at the top:

```ts
// Moved to site-links.ts. Re-exported so the five modules that import them
// from here keep working; prefer importing from site-links.ts in new code.
export { escapeMarkdown, profileUrl, who } from "./site-links.js";
```

⚠️ `KillFeedSide` must stay exported from `kill-feed-embed.ts` — `site-links.ts` imports the type from it, so moving the type too would make the import circular.

- [ ] **Step 5: Run the bot suite**

```bash
cd apps/bot && npx vitest run test/
```

Expected: PASS. The `who()` change means the kill/hit/killstreak/long-range feed tests now see a linked tag — update their expected strings, which is the point of the change (audit rows 18, 19).

- [ ] **Step 6: Commit**

```bash
git add apps/bot/src/site-links.ts apps/bot/src/kill-feed-embed.ts apps/bot/test/
git commit -m "feat(bot): add site-link builders and renderers, link clan tags in feeds"
```

---

## Task 5: Drop `relativeAge` and the `now` thread

**Files:**
- Modify: `apps/bot/src/notice-text.ts`
- Modify: `apps/bot/src/notice-tick.ts`
- Modify: `apps/bot/test/notice-text.test.ts` and any other caller

**Interfaces:**
- Consumes: `rel` from Task 1.
- Produces: `noticeText(n): string` (no `now`), `noticeMessage(row, siteBaseUrl): NoticeMessage` (no `now`).

Spec §4.2 — the widest blast radius in increment 1, so it gets its own task and its own review gate.

- [ ] **Step 1: Write the failing test**

Replace the age assertions in `apps/bot/test/notice-text.test.ts` with:

```ts
it("renders an intruder sighting with a live token, not a baked age", () => {
  const occurredAt = new Date("2026-09-21T14:30:00.000Z");
  const line = noticeText({
    kind: "intruder",
    target: "channel",
    occurredAt,
    payload: { gamertag: "SomePlayer", distance: 60 },
  });
  expect(line).toContain("<t:1790001000:R>");
  expect(line).not.toContain("min ago");
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
cd apps/bot && npx vitest run test/notice-text.test.ts
```

Expected: FAIL — `noticeText` still requires a second `now` argument and renders `relativeAge`.

- [ ] **Step 3: Change `notice-text.ts`**

Delete `relativeAge` and the `MIN_MS` constant. Change the context type and the entry point:

```ts
type RendererCtx = { target: NoticeTarget; age: string };
```

becomes

```ts
/**
 * ⚠️ `age` is a Discord `<t:…:R>` token, not a baked string. It used to be
 * `relativeAge(occurredAt, now)`, which froze "6 min ago" into a message
 * that then sat in a channel for weeks saying so. The token counts by
 * itself, which is why `noticeText` no longer takes a clock at all.
 */
type RendererCtx = { target: NoticeTarget; age: string };
```

and:

```ts
export function noticeText(n: { kind: ClanNoticeKind; target: NoticeTarget; occurredAt: Date; payload: NoticePayload }): string {
  // ⚠️ `?? ""` is the degrade for an unrepresentable occurredAt: the line
  // loses its "when" rather than posting a literal <t:NaN:R> that nothing
  // will ever repost over.
  return RENDERERS[n.kind](n.payload, { target: n.target, age: rel(n.occurredAt) ?? "" });
}
```

Import `rel` from `@factions/copy`.

⚠️ The ten renderers that use `ctx.age` end with `— ${ctx.age}`. With an empty degrade that leaves a trailing `— `. Change those ten to build the clause conditionally:

```ts
const since = (ctx: RendererCtx) => (ctx.age === "" ? "" : ` — ${ctx.age}`);
```

and use `${since(ctx)}` in place of ` — ${ctx.age}`.

- [ ] **Step 4: Change `notice-tick.ts`**

`noticeMessage(row, now, siteBaseUrl)` → `noticeMessage(row, siteBaseUrl)`; `noticeText(row, now)` → `noticeText(row)`. Follow the compiler to its callers in `discord.ts` and the tests.

- [ ] **Step 5: Run the bot suite**

```bash
cd apps/bot && npx vitest run test/
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/bot
git commit -m "refactor(bot): notice ages are live Discord tokens, drop the clock argument"
```

---

## Task 6: Broadcast surfaces — raid window, vehicle wipe, airdrop

**Files:**
- Modify: `apps/bot/src/raid-window-text.ts`, `apps/bot/src/announce-text.ts`, `apps/bot/src/airdrop-text.ts`
- Modify: `apps/bot/test/announce-text.test.ts`

**Interfaces:**
- Consumes: `at`, `rel`, `atRel` from Task 1.
- Produces: unchanged function signatures except `weeklyWipeAnnouncement(vehicle, wipeAt)` — the `now` argument goes.

Audit rows 1–8.

- [ ] **Step 1: Write the failing test**

Replace the `whenPhrase` cases in `apps/bot/test/announce-text.test.ts`:

```ts
it("states the wipe as a token, with no 'tomorrow' arithmetic", () => {
  const wipeAt = new Date("2026-09-21T10:00:00.000Z");
  const text = weeklyWipeAnnouncement({ name: "Olga 24", event: "VehicleOlga24" }, wipeAt);
  expect(text).toContain("<t:1789984800:F>");
  expect(text).toContain("<t:1789984800:R>");
  expect(text).not.toContain("tomorrow");
  expect(text).not.toContain("UTC");
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
cd apps/bot && npx vitest run test/announce-text.test.ts
```

Expected: FAIL — arity mismatch, and the output still says "tomorrow".

- [ ] **Step 3: Rewrite `announce-text.ts`**

Delete `whenPhrase`, `utcDayStart` and `HOUR_MS` entirely, and with them the bug their own comment documents (the posting window reaches Monday 00:00–07:00 UTC, so a late post said "tomorrow" hours before the wipe). The file becomes:

```ts
import type { WipeVehicle } from "@factions/domain";
import { atRel } from "@factions/copy";

/**
 * The Sunday notice. Plain content, no embed — it is one short sentence of
 * fact, and the other plain-text poster (#war-log) is the house precedent.
 *
 * ⚠️ Takes no clock. It used to compute "tomorrow" vs "today, in about N
 * hours" against `now`, which was wrong whenever the bot recovered late
 * inside the posting window. `atRel` cannot have that bug: the token is
 * the instant, and Discord does the arithmetic per reader.
 */
export function weeklyWipeAnnouncement(vehicle: WipeVehicle, wipeAt: Date): string {
  const stamp = atRel(wipeAt);
  return [
    `🚗 **Weekly vehicle wipe — ${stamp ?? "at the next restart"}**`,
    `This week it's **${vehicle.name}** (\`${vehicle.event}\`). Every one on the map is `
      + `cleared at that restart and respawns fresh a couple of hours later.`,
    `Move anything you want to keep out of them before then.`,
  ].join("\n");
}
```

Update `announce-tick.ts`, which passes `now`.

- [ ] **Step 4: Rewrite `raid-window-text.ts`'s three player-facing functions**

Delete the local `stamp()` and import from `@factions/copy`. Per audit rows 1, 3, 4:

```ts
import { at, atRel, rel } from "@factions/copy";
```

- `advanceText`: `Base damage comes on at ${atRel(state.opensAt) ?? "the next restart"} and goes off at ${at(state.closesAt) ?? "the restart after"}.`
- `openText`: `It closes ${rel(state.closesAt) ?? "at the scheduled restart"}.`
- `closeText`: `The next one opens at ${atRel(state.opensAt) ?? "the next scheduled window"}.`

⚠️ `failureText` is **unchanged** — it keeps `.toISOString()`. It is ops-facing and its own comment is right: whoever reads it at 02:00 needs an unambiguous machine timestamp, not a friendly one.

- [ ] **Step 5: Point `airdrop-text.ts` at the shared helper**

Delete the local `countdown()`, import `rel` from `@factions/copy`, and degrade explicitly:

```ts
`A locked container drops at ${place(location)} when the server comes back up, ${rel(slotAt) ?? "at the next restart"}.`
```

Everything else in that file stays: the location-not-colour rule, and the no-em-dash style that file already follows.

- [ ] **Step 6: Run the bot suite**

```bash
cd apps/bot && npx vitest run test/
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/bot
git commit -m "feat(bot): broadcast notices state time as Discord tokens"
```

---

## Task 7: `#war-log` and `#bans`

**Files:**
- Modify: `apps/bot/src/war-log-text.ts`
- Modify: `apps/bot/src/ban-announce-text.ts`
- Modify: `apps/bot/test/war-log-text.test.ts`, `apps/bot/test/ban-announce-text.test.ts`

**Interfaces:**
- Consumes: `clanLink`, `playerLink` (Task 4), `at` (Task 1).

Audit rows 9–15.

- [ ] **Step 1: Write the failing test**

In `apps/bot/test/war-log-text.test.ts`:

```ts
it("links both clans and the raider", () => {
  const line = warLogText({
    kind: "raid",
    payload: { raiderClan: "Nomads", raiderTag: "NOMAD", victimClan: "Vultures", victimTag: "VULT", gamertag: "SomePlayer" },
  }, "https://dayzclanwars.com");
  expect(line).toContain("**[Nomads](<https://dayzclanwars.com/clans/NOMAD>)**");
  expect(line).toContain("**[Vultures](<https://dayzclanwars.com/clans/VULT>)**");
  expect(line).toContain("[SomePlayer](<https://dayzclanwars.com/players/SomePlayer>)");
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
cd apps/bot && npx vitest run test/war-log-text.test.ts
```

Expected: FAIL — the clans render as plain bold text.

- [ ] **Step 3: Add the missing tags at the two writers that omit them**

⚠️ **Checked 2026-09-21; two of the four payloads already carry the tag and two do not.**
`clanUrl` needs the **tag**, and the payload is frozen at write time on purpose — re-reading
`factions` at post time would print today's name on a late post.

| Kind | Writer | Carries today | Action |
|---|---|---|---|
| `raid` | `apps/bot/src/raid-tick.ts:126` | `raiderTag`, `victimTag` | none — already there |
| `defense` | `apps/bot/src/raise-tick.ts:116` | `victimTag` | none — already there |
| `week_closed` | `apps/bot/src/week-tick.ts:70` | names + points only | **add `t1`/`t2`/`t3`** |
| `season_closed` | `apps/bot/src/season-close.ts:61` | `clan` name only | **add `tag`** |

In `week-tick.ts`, beside the existing `first`/`second`/`third`:

```ts
          t1: top[0]?.tag ?? null, t2: top[1]?.tag ?? null, t3: top[2]?.tag ?? null,
```

In `season-close.ts`:

```ts
    payload: { number: season.number, clan: champion?.name ?? null, tag: champion?.tag ?? null, points: champion?.points ?? null },
```

⚠️ Confirm `top[n]` and `champion` actually select `tag` — widen the query if not.

⚠️ **Rows already written have no tag and never will.** The renderer must handle that arm,
which is what the `clan()` helper in Step 4 is for. Add a test for it: a `week_closed`
payload with `t1: undefined` renders the clan bold and unlinked, not as a broken link.

- [ ] **Step 4: Rewrite the renderer**

```ts
import { clanLink, playerLink } from "./site-links.js";

/** A clan links only when its tag was frozen into the payload; older rows have none. */
const clan = (site: string, name: unknown, tag: unknown): string =>
  typeof tag === "string" && tag !== "" ? clanLink(site, tag, String(name)) : `**${String(name)}**`;
```

Apply to `raid`, `defense`, `week_closed` and `season_closed`. In `season_closed`, mask the URL: `Full table: [seasons](<${siteBaseUrl}/seasons>)`, and add `at(e.occurredAt)` per audit row 12.

⚠️ Leave the emoji alone in this task. They come out in increment 2, when these become embeds and colour takes over.

- [ ] **Step 5: `#bans` — add the token, leave the gamertag unlinked**

In `ban-announce-text.ts`, replace `formatDate(a.expiresAt)` with `at(new Date(a.expiresAt)) ?? formatDate(a.expiresAt)` and delete `formatDate`/`MONTHS` if nothing else uses them.

⚠️ **Do not link the gamertag** (audit row 13). It is frozen player-controlled text that may not resolve to a page, and this file carries two warnings about not trusting that input. Add a test asserting it stays unlinked, so a future pass does not "finish the job".

- [ ] **Step 6: Run the bot suite**

```bash
cd apps/bot && npx vitest run test/
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/bot
git commit -m "feat(bot): link clans in #war-log, token-stamp ban expiry"
```

---

## Task 8: Feeds and standing boards

**Files:**
- Modify: `apps/bot/src/feed-embed.ts`, `online-embed.ts`, `leaderboard-embed.ts`, `achievement-embed.ts`, `dormancy-notify.ts`, `ceremony-notify.ts`

**Interfaces:**
- Consumes: Tasks 1 and 4.

Audit rows 16–23, 39–41.

- [ ] **Step 1: Write the failing test**

In `apps/bot/test/feed-embed.test.ts` (create if absent):

```ts
it("titles a clan with a link to its page", () => {
  const embed = feedEmbed({
    kind: "founded",
    occurredAt: new Date("2026-09-21T14:30:00.000Z"),
    payload: { name: "Nomads", tag: "NOMAD", texture: "Flag_Wolf", actor: "SomePlayer" },
  } as never);
  expect(embed.url).toBe("https://dayzclanwars.com/clans/NOMAD");
  expect(embed.url).not.toContain("<");
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
cd apps/bot && npx vitest run test/feed-embed.test.ts
```

Expected: FAIL — `feedEmbed` takes no `siteBaseUrl` and sets no `url`.

- [ ] **Step 3: Apply the changes**

- `feed-embed.ts` — take `siteBaseUrl`, set `url: clanUrl(siteBaseUrl, p.tag)` (**bare** — this is an embed URL field). Replace the inline `<t:…:R>` with `rel(new Date(ms))`, keeping the existing `Number.isFinite` degrade to `DORMANT_SENTENCE`. Thread `siteBaseUrl` from `feed-tick.ts`.
- `online-embed.ts` — replace the inline token with `rel()`; wrap the `[TAG]` in `clanLink(siteBaseUrl, p.tag)`.
- `leaderboard-embed.ts` — the gamertag is already linked; wrap the clan tag in `clanLink`. Keep `boardUrl` bare (it feeds `setURL`).
- `achievement-embed.ts` — link the owner: `clanLink(site, p.clanTag, ...)` for a clan, `playerLink(site, p.gamertag)` for a player. ⚠️ Leave `achievementMention` exactly as it is — a mention inside an embed does not ping, which is why it rides in the content.
- `dormancy-notify.ts` — replace the inline token with `rel()`; render the clan as `clanLink(site, n.tag, n.name)`. Thread `siteBaseUrl` in.
- `ceremony-notify.ts` — replace the inline token with `rel()`; render participants with `playerLink`; mask the claim URL as `[found the clan](<…/claim/${c.id}>)`.

- [ ] **Step 4: Run the bot suite**

```bash
cd apps/bot && npx vitest run test/
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/bot
git commit -m "feat(bot): link clans across feeds, boards and DMs"
```

---

## Task 9: Clan notices — links and the hardcoded durations

**Files:**
- Modify: `apps/bot/src/notice-text.ts`
- Modify: `apps/bot/test/notice-text.test.ts`

**Interfaces:**
- Consumes: Tasks 1, 4, 5.

Audit rows 24–38, plus spec §3.4's principle-2 fix.

⚠️ `noticeText` has no `siteBaseUrl` today. Thread it in from `noticeMessage`, which already receives one.

- [ ] **Step 1: Write the failing test**

```ts
it("interpolates the dormancy windows rather than typing them", () => {
  const line = noticeText({
    kind: "dormant_inactive", target: "channel",
    occurredAt: new Date("2026-09-21T14:30:00.000Z"), payload: {},
  }, "https://dayzclanwars.com");
  expect(line).toContain(`${Math.round(DORMANT_AFTER_MS / 86_400_000)} days`);
});

it("links a gamertag in a channel notice", () => {
  const line = noticeText({
    kind: "joined", target: "channel",
    occurredAt: new Date("2026-09-21T14:30:00.000Z"), payload: { gamertag: "SomePlayer" },
  }, "https://dayzclanwars.com");
  expect(line).toContain("[SomePlayer](<https://dayzclanwars.com/players/SomePlayer>)");
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
cd apps/bot && npx vitest run test/notice-text.test.ts
```

Expected: FAIL on arity, and `dormant_inactive` still says a typed "7 days".

- [ ] **Step 3: Make `person()` link**

```ts
/**
 * A payload's gamertag slot, honestly. A missing name renders as `someone`;
 * an all-digit value is a raw Discord id (see `gamertagOrId`) and renders as
 * a MENTION, not a link — a mention pings, which is the entire reason that
 * fallback exists. Only a real gamertag becomes a profile link.
 */
function person(v: NoticePayload[string] | undefined, site: string): string {
  if (v === null || v === undefined || v === "") return "someone";
  const s = String(v);
  return /^\d+$/u.test(s) ? `<@${s}>` : playerLink(site, s);
}
```

⚠️ **The mention arm must not become a link.** These notices ping on purpose (`PING_KINDS` in `notice-tick.ts`), and a link does not ping.

- [ ] **Step 4: Thread `site` through the renderers**

`RendererCtx` gains `site: string`; every renderer that calls `person` passes `ctx.site`.

- [ ] **Step 5: Fix the five hardcoded durations**

Import the windows from `@factions/domain` and interpolate, matching what the file already does for `RELEASED_POLE_GRACE_MS` and `SOLO_LAPSE_MS`:

| Renderer | Typed today | Source | Which |
|---|---|---|---|
| `dormant_inactive` | "in 7 days" | **bot config** `cfg.dormantAfterMs` | threaded in |
| `flag_down` | "Re-raise within 24h" | `RAID_DEDUP_MS` (`packages/domain/src/rules.ts:44`) | imported |
| `dormant_raided` | "24 hours passed" | `RAID_DEDUP_MS` | imported |
| `rebind_proposed` | "within 24h" | `REBIND_CONFIRM_MS` (`rules.ts:74`) | imported |
| `disband_warning` | `p.days` from the payload | already interpolated | none |

⚠️ **`dormant_inactive` is the trap.** `packages/domain/src/rules.ts:50` exports
`DORMANT_AFTER_MS = 7 * DAY`, which looks like the right import and is not: the value the
bot actually runs is `cfg.dormantAfterMs`, read from `BOT_DORMANT_AFTER_MS` with
`DEFAULT_DORMANT_AFTER_MS` as its default (`config.ts:416`). Staging can set something
under a day. `dormancy-notify.ts` already interpolates from config and formats sub-day
windows as hours — follow that file, not the domain constant, or the notice names a number
this server does not use.

Threading config into `notice-text.ts` means `RendererCtx` gains the window alongside
`site`. Pass it from `noticeMessage`, the same way `siteBaseUrl` arrives.

- [ ] **Step 6: Link the clans and mask the URLs**

Per audit rows 28–37: `p.link` becomes `[open it](<${p.link}>)`; `**${p.clan}**` becomes `clanLink(ctx.site, p.tag, String(p.clan))` wherever the payload carries a tag. Where it does not, leave it bold and unlinked — do not re-read `factions` at render time.

- [ ] **Step 7: Run the bot suite**

```bash
cd apps/bot && npx vitest run test/
```

Expected: PASS. `notice-text.test.ts`'s exhaustiveness check still pins the renderer table to exactly `CLAN_NOTICE_KINDS` — leave that check alone.

- [ ] **Step 8: Commit**

```bash
git add apps/bot
git commit -m "feat(bot): link players and clans in notices, interpolate the dormancy windows"
```

---

## Task 10: Slash-command embeds

**Files:**
- Modify: `apps/bot/src/commands/embeds/{clan,clans,scoring,stats,me,base,map,vault,found,link}.ts`

**Interfaces:**
- Consumes: Tasks 1, 3, 4, and Task 0's answer.

Audit rows 42–59.

- [ ] **Step 1: Write the failing test**

```ts
it("links each clan in the directory", () => {
  const embed = directoryEmbed(
    [{ name: "Nomads", tag: "NOMAD", memberCount: 4, alpha: false, recruiting: true }],
    "https://dayzclanwars.com",
  ).toJSON();
  expect(embed.fields?.[0]?.value).toContain("[Nomads](<https://dayzclanwars.com/clans/NOMAD>)");
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
cd apps/bot && npx vitest run test/
```

- [ ] **Step 3: Apply the per-row changes**

| File | Change |
|---|---|
| `clan.ts` | `when(c.raisedAt)` → `atRel`; link roster gamertags, claimant, nominee |
| `clans.ts` | link each directory row and each roster gamertag |
| `scoring.ts` | `/scoreboard` and `/seasons` link each clan; `seasonsEmbed` `when` → `at`; `warLogEmbed` `when` → `rel` and links the clans |
| `stats.ts` | `/player` links the clan field; `/board` links gamertag and tag |
| `me.ts` | link every clan named (current, pending, invites, requests) |
| `base.ts` | ⚠️ **already done in Task 3 step 5** — verify only, do not redo |
| `map.ts` | `when(expiresAt)` → `rel`; link the pin author |
| `vault.ts` | `when(h.at)` → `rel`; link the actor |
| `found.ts` | `when(expiresAt)` → `atRel` (a field **value**); link participants |
| `link.ts` | ⚠️ **`held-by-other` already done in Task 3 step 5** — verify only. Keep `formatRemaining` as it is |

⚠️ **`/alphas` (`scoring.ts`) keeps `when(w.weekStart)`** if Task 0 found that field **names** do not render tokens. That is the expected outcome. Leave a comment saying why, or a future pass will "fix" it into a literal `<t:…>` on the card.

⚠️ Every embed `setURL()` call keeps a **bare** URL. Only inline text gets `<>`.

- [ ] **Step 4: Run the full gate**

```bash
cd /Users/steveharmeyer/Development/dayz-clan-wars/clan-wars
TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions" \
  npx turbo run typecheck test --concurrency=1 --force
```

Expected: **30/30 tasks**. Check the count, not the exit code.

- [ ] **Step 5: Commit**

```bash
git add apps/bot
git commit -m "feat(bot): link clans and players across slash-command cards"
```

---

## Task 11: The channel move

**Files:**
- Modify: `apps/bot/src/config.ts`, `apps/bot/src/discord.ts`
- Modify: `docs/deploy/raid-window.md`, `docs/deploy/2026-09-17-raid-window.md`, `docs/deploy/2026-09-12-weekly-vehicle-rotation.md`
- Create: `docs/deploy/2026-09-21-server-events-channel.md`
- Modify: `CLAUDE.md`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `cfg.announcementsChannelId` no longer exists.

Spec §3.3.

- [ ] **Step 1: Write the failing test**

In `apps/bot/test/config.test.ts`:

```ts
it("refuses RAID_WINDOW_TICK without SERVER_EVENTS_CHANNEL_ID", () => {
  expect(() => loadConfig({ ...ON, SERVER_EVENTS_CHANNEL_ID: undefined }))
    .toThrow(/RAID_WINDOW_TICK is on but SERVER_EVENTS_CHANNEL_ID/u);
});

it("refuses WEEKLY_VEHICLE_WIPE without SERVER_EVENTS_CHANNEL_ID", () => {
  expect(() => loadConfig({ ...WIPE_ON, SERVER_EVENTS_CHANNEL_ID: undefined }))
    .toThrow(/WEEKLY_VEHICLE_WIPE is on but SERVER_EVENTS_CHANNEL_ID/u);
});

it("no longer reads ANNOUNCEMENTS_CHANNEL_ID", () => {
  const cfg = loadConfig({ ...ON, ANNOUNCEMENTS_CHANNEL_ID: "123456789012345678" });
  expect("announcementsChannelId" in cfg).toBe(false);
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
cd apps/bot && npx vitest run test/config.test.ts
```

- [ ] **Step 3: Change `config.ts`**

Delete `announcementsChannelId` from the interface (line ~169) and the loader (line ~468). Re-point the raid-window gate (line ~530) and add the vehicle-wipe one. Each names its own feature — do not share one error string:

```ts
if (config.raidWindow.enabled && !config.serverEventsChannelId) {
  throw new Error("RAID_WINDOW_TICK is on but SERVER_EVENTS_CHANNEL_ID is unset — the feature posts player-facing advance/open/close notices, and with no channel to post them to it is misconfigured, not merely degraded.");
}
if (config.truckWipe.rotation && !config.serverEventsChannelId) {
  throw new Error("WEEKLY_VEHICLE_WIPE is on but SERVER_EVENTS_CHANNEL_ID is unset — the Sunday notice is the only warning a player gets before their vehicle is cleared.");
}
```

Keep the existing `⚠️ Fatal, unlike OPS_CHANNEL_ID` comment block above the raid-window check — its reasoning about the write-order hazard is unchanged and still load-bearing.

⚠️ The `AIRDROP_TICK` check stays exactly as it is. Its wording ("the only way a drop is ever found") is true of airdrops and false of the other two, which is why each gate gets its own sentence.

- [ ] **Step 4: Change `discord.ts`**

Delete `announcePoster` (line ~603). Pass `serverEventsPoster` to `raidWindowTick` (line ~1585) and `announceTick` (line ~1611). Rewrite the comments at 1573/1584 to name the new gate. Delete the startup warning at 1653.

⚠️ `announceTick`'s call site is currently gated `if (cfg.truckWipe.rotation && announcePoster)`. With the fatal gate in place it becomes `if (cfg.truckWipe.rotation)` with a `serverEventsPoster!`, matching how the raid window and airdrop calls already read.

⚠️ `ctxNow`'s `serverEvents: cfg.airdrop.enabled ? serverEventsPoster : null` **stays as it is** — that is the `/airdrop place` command's own gate, not the channel's.

- [ ] **Step 5: Write the deploy note**

`docs/deploy/2026-09-21-server-events-channel.md` must state:

1. `SERVER_EVENTS_CHANNEL_ID` is already set in prod, so no env change is needed **before** the restart.
2. ⚠️ **`ANNOUNCEMENTS_CHANNEL_ID` stays in `/opt/clan-wars/.env`.** The bot no longer reads it, but the manual announcement workflow from the prod host does. Removing it from `config.ts` is not a licence to remove it from the env file.
3. After the restart, `#server-events` carries airdrops, the raid window and the vehicle wipe; `#announcements` is human-only.

- [ ] **Step 6: Update the three existing runbooks and `CLAUDE.md`**

All name `ANNOUNCEMENTS_CHANNEL_ID` and are wrong the moment this ships. In `CLAUDE.md`, that is the raid-window row (line ~390) and the vehicle-rotation row (line ~399) of the "Where things live" table, plus the `announce-tick` mention around line 256.

- [ ] **Step 7: Run the full gate**

```bash
cd /Users/steveharmeyer/Development/dayz-clan-wars/clan-wars
TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions" \
  npx turbo run typecheck test --concurrency=1 --force
```

Expected: **30/30 tasks**.

- [ ] **Step 8: Commit**

```bash
git add apps/bot docs CLAUDE.md
git commit -m "feat(bot): move raid window and vehicle wipe notices to #server-events"
```

---

## Task 12: Brand guide, changelog, PR

**Files:**
- Modify: `../brand/02-verbal-identity.md`

⚠️ **PRE-FLIGHT RULING (controller, 2026-09-21): `brand/` is NOT under version control.**
It sits in the parent directory `dayz-clan-wars/`, which is not a git repository at all.
The brand-guide edits are therefore real and wanted, but they **cannot be committed, will
not appear in the PR, and will not be reviewed**. Make the edits; do NOT `git add` them;
mention in the PR body that the brand guide was amended out-of-tree.
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Amend the Dates mechanic**

Replace the bullet reading *"**Dates are UTC**, formatted `9 Sep` (`en-GB`, day + short month). The server's timezone must not change what a player reads."* with:

```markdown
- **Dates.** In Discord, an instant is a `<t:…>` token, so every reader sees it in their
  own timezone and a posted message stays correct without an edit; a duration is a
  literal number interpolated from `@factions/domain`. On the website, and in the two
  Discord surfaces where a token cannot render — an ops alert, and an embed field name —
  dates are UTC, formatted `9 Sep` (`en-GB`, day + short month).
```

- [ ] **Step 2: Make the emoji rule explicit**

Replace *"**No emoji** in site copy. Discord embeds use colour and thumbnails, not emoji, to signal kind."* with:

```markdown
- **No emoji** in site copy. In Discord the rule is by surface: an **embed** signals kind
  with colour and thumbnails, never emoji; a **plain-text** line may carry one leading
  glyph, because it has no colour to signal with and a clan channel is read by scrolling.
```

- [ ] **Step 3: Add the changelog entry**

⚠️ Required, and it must be **committed**, not merely edited — the CI gate diffs against the committed state at the PR base.

```markdown
### Changed
- Every Discord message states time with live `<t:…>` timestamps instead of a baked
  clock, so a posted notice stays correct without an edit.
- Clan names and gamertags across Discord link to their pages on the site.
- The raid window and weekly vehicle wipe notices post to `#server-events` beside the
  airdrops; `#announcements` is now human-only.
```

- [ ] **Step 4: Run the full gate one last time**

```bash
cd /Users/steveharmeyer/Development/dayz-clan-wars/clan-wars
TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions" \
  npx turbo run typecheck test --concurrency=1 --force
```

Expected: **30/30 tasks**.

- [ ] **Step 5: Open the PR**

Use the `keel:finish-work` skill.

---

## Self-review notes

**Spec coverage.** §2.1 → Task 1. §2.2 → Task 4. §2.3 → Tasks 2 and 3. §3.1 → Tasks 5–10. §3.2 → Tasks 4, 7, 8, 9, 10. §3.3 → Task 11. §3.4 → Tasks 9 and 12. §3.5 → the ⚠️ guards in Tasks 6, 7, 10. §4.1 → Task 0. §4.2 → Task 5. §4.3 → Task 12. §4.4 → Task 11 steps 5–6. §4.5 → Global Constraints. §6 → each task's test step, plus Tasks 2 and 4 for the new suites. §5 (increment 2) is deliberately out of scope.

**Both open questions from the first draft were closed before this plan was finished, and one changed the work:**

- `war_log_events.payload` carries the clan tag for `raid` and `defense` but **not** for
  `week_closed` or `season_closed`. Task 7 step 3 therefore includes a writer change to
  `week-tick.ts` and `season-close.ts`, plus the unlinked arm for rows already written.
- The dormancy window is both a domain constant and a config value, and they can disagree.
  Task 9 step 5 names which source each of the four durations takes, and flags
  `dormant_inactive` as the one where the obvious import is the wrong one.

**What a reviewer should still push back on:** Task 7's writer change widens a frozen
payload. That is correct here — the tag is an identifier, not a coordinate, and
`faction_events_no_coordinates` is unaffected — but any future addition to a frozen payload
deserves the same scrutiny.
