# Weekly Show 3: Stages and Publishing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn `apps/show` from a local dry-run/render tool into the scheduled service the spec describes. A timer run picks the week and walks one `show_episodes` row through context, script, voice, render, YouTube, approval in the ops channel, the Discord forum and Facebook. The row resumes after any crash without double-posting.

**Architecture:**
- `src/stages/` owns the state machine: a row store, the week picker, and the ops and forum text.
- `runStages(deps, weekStart)` runs the stages. Every external effect reaches it through an injected `StageDeps`, so the whole machine is tested against the real test database with fakes for the LLM, TTS, render, YouTube, Discord and Facebook.
- The publish clients are ported from KOTH or written fresh: YouTube, Facebook, and Discord REST. They live under `src/engine/publish/`, take config as parameters and never read the environment. `boundary.test.ts` already enforces that for everything under `src/engine/`.
- `src/service.ts` does the wiring: it takes the advisory lock, reads config, picks the week and builds the real deps.
- `cli.ts` sends `--dry-run` and `--render` to the existing path and every other invocation to the service.

**Tech Stack:** TypeScript ESM (`.js` import suffixes), vitest 2, drizzle-orm 0.36 over postgres.js, Node 20 `fetch`/`FormData`/`Blob`, systemd.

**Spec:** `docs/superpowers/specs/2026-09-25-weekly-show-design.md`. This plan covers §2.4 (titles), §2.5, §2.6, §8, §9, §10, §13 (the remaining keys), §14, the stage tests in §15, and §11.1's YouTube, Facebook and youtube-auth rows. Plans 1 and 2 (`2026-09-25-weekly-show-1-story-and-script.md`, `2026-09-26-weekly-show-2-voice-and-video.md`) are merged.

## Global Constraints

- **Imports:** ESM `.js` suffixes on relative imports.
  - `src/engine/**` never imports `@factions/*` or `story|cards|stores|produce|screening|prompt|script|stages`, and never reads `process.env`. Task 4 adds `stages` to `FORBIDDEN_DIRS` in `test/engine/boundary.test.ts`.
- **Player-facing copy** (YouTube title and description, forum thread, transcript, Facebook caption):
  - No em dash (`—`) anywhere; en dash is also out.
  - Says "clan", never "faction".
  - Never discourages raiding.
  - A redacted alias (`REDACTED_PLAYER_n`, `REDACTED_CLAN_n`) is written as `[REDACTED]`.
- **Ops channel posts never carry raw blocked text** (a blocked gamertag, a blocklist term, a moderator's reason). They carry counts and categories only. The raw text stays in the row, which `pnpm show:screening --show <week>` prints in the operator's terminal.
- **Discord requests:**
  - Every request carries `User-Agent: DiscordBot (https://dayzclanwars.com, 1.0)`, because Cloudflare rejects requests without one.
  - Every message carries `allowed_mentions: { parse: [] }`.
  - Plain `content` is capped at 2,000 characters. An embed `description` is capped at 4,096, with 6,000 total per message and at most 10 embeds.
- **Idempotency (spec §8.3):**
  - Before any external post or upload, a stage checks its id column, then looks for the artifact on the remote side (by title, marker or link). Only then does it post.
  - It writes the row right after the post succeeds.
  - A crash between the post and the row write must never produce a second post.
- **Titles (spec §2.4):**
  - YouTube: `The Bloodbag and Painkiller Show: Clan Wars S01E03 · The Curse`.
  - Discord thread: `Clan Wars S01E03 · The Curse`.
  - The `·` is U+00B7.
- **Stage names:** exactly the `ShowStage` values in `@factions/domain`: `new, context, scripted, voiced, rendered, uploaded, awaiting_approval, approved, public, posted, done, held, rejected`. `stage` names the last stage that FINISHED.
- **Alerts:** at exactly 3 attempts on one stage the ops channel gets one alert. It is not repeated at 4, 5 and so on.
- **Lock:** `SHOW_LOCK_KEY = 8_531_208`. The bot's instance lock is `8_531_207`; never reuse it.
- **Gate:** `TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions" npx turbo run typecheck test --concurrency=1 --force` must read **32/32**. Never run two test runs at once. For a single package, run `cd apps/show && TEST_DATABASE_URL=... npx vitest run <path>`.
- **Commits:** conventional-commit subjects. Every commit ends with the attribution lines the session gives.

## Review Focus

1. **A crash between a remote post and the row write.** The next run must adopt the existing YouTube video, ops draft, forum thread, transcript message or Facebook video, not create a second one. Tasks 9 and 10 each have a "crash window" test per external effect.
2. **An awaiting-approval draft with reactions from the wrong people** (the bot itself, a non-approver, both ✅ and ❌ from approvers). Only an approver's reaction counts, and ❌ beats ✅. Covered in Task 10.
3. **A held script whose reasons name a blocked gamertag or slur.** The ops note must not contain the string. Covered in Tasks 7 and 9.
4. **`--force` on a public episode without `--repost`** must refuse and change nothing. With `--repost` it must clear the forum and Facebook ids so the episode posts again. Covered in Task 3.
5. **A week whose ingest is behind (no events past week end, less than 6 h since)** must not be picked. An empty server past week end + 6 h must be picked. Covered in Task 3.

## Rulings made while writing this plan

- **`DISCORD_GUILD_ID`** is read too (spec §13 does not list it). Finding a forum thread after a crash needs `GET /guilds/{guild}/threads/active`.
- **`SITE_BASE_URL` is not read.** Nothing in plan 3 links to the site except fixed copy (`dayzclanwars.com` is already on the marquee).
- **An awaiting-approval episode blocks later weeks.** Spec §8.1 picks the earliest unfinished row. The runbook says so.
- **The ops draft carries the transcript as an attached `transcript.txt`, not as embeds.** One message, so the reaction target is unambiguous. Embeds would need a second message for any script over 6,000 characters.
- **The forum transcript is "the second message", or the second and third when the formatted transcript needs more than one message of embeds.** The mp3 is attached to the first of them.
- **Plan-2 parked items:**
  - Closed here: the alias collision in `previous` (Task 1), `seasonForWeek` taking any server (Task 1), persisting the blocked list at the context stage (Task 9), and raw blocked text in held reasons (Task 7).
  - Still parked, with reasons:
    - Cache-key inputs: `--force` regenerates the narrative, and so the key.
    - The per-turn TTS cache: one retry per failure costs one episode of ElevenLabs characters, which is acceptable weekly.
    - The card name clip at 12 characters and the outro board spacing: cosmetic, and the user reviewed both renders without raising them.

## File Structure

| File | Responsibility |
|---|---|
| `src/story/context.ts` (modify) | neutralize last episode's aliases before registration |
| `src/story/season.ts` (modify) | only seasons on active servers |
| `src/config.ts` (modify) | `loadServiceConfig`, `SHOW_LOCK_KEY` |
| `src/stages/store.ts` | the `show_episodes` row: get, create, advance, set, fail, force |
| `src/stages/pick.ts` | `pickWeek`: the earliest unfinished week, else the last ended week once it is ready |
| `src/engine/publish/discord.ts` | Discord REST: post (json or multipart), react, reactions, recent messages, forum threads |
| `src/engine/publish/youtube/youtube.ts` | ported upload, token, processing poll; new privacy, playlist, find-by-title |
| `src/engine/publish/youtube/buildVideoMeta.ts` | the title and description |
| `src/engine/publish/facebook/facebook.ts` | ported Page upload, plus find by link |
| `src/engine/publish/facebook/buildFacebookCaption.ts` | the caption |
| `src/stages/text.ts` | public transcript, ops draft, held note, alert, forum name, transcript messages, `opsSafe` |
| `src/stages/run.ts` | `StageDeps`, `runStages`, every stage step, failure accounting |
| `src/dry-run.ts` | the existing `--dry-run` / `--render` body, moved out of `cli.ts` unchanged |
| `src/service.ts` | lock, config, `--force`, pick, real deps, `runStages` |
| `src/cli.ts` (rewrite) | argument parsing and dispatch |
| `src/ops/screening-cli.ts`, `src/ops/backfill.ts`, `src/ops/backfill-cli.ts` | operator commands |
| `scripts/youtube-auth.ts` | mints the refresh token with the `youtube` scope |
| `deploy/systemd/clan-wars-show.{service,timer}` | the oneshot and its timer |
| `docs/deploy/2026-09-26-weekly-show.md` | the runbook |
| `apps/show/README.md`, `CLAUDE.md`, `CHANGELOG.md`, `apps/bot/test/vocabulary.test.ts` | docs and the vocabulary check |

---

### Task 1: Story fixes carried from plan 2

**Files:**
- Modify: `apps/show/src/story/context.ts` (the `previous` block, about lines 70-80)
- Modify: `apps/show/src/story/season.ts`
- Test: `apps/show/test/story/context.test.ts`, `apps/show/test/story/season.test.ts` (create)

**Interfaces:**
- Produces: `neutralizeAliases(s: string): string` exported from `src/story/context.ts`. Nothing else changes shape.

Why:
- Last week's storylines were written from last week's redacted context, so they can say `REDACTED_PLAYER_1`. This week's redaction numbers its own aliases from 1, so the same alias would name two different people in one prompt. The fix rewrites last week's aliases into plain prose and drops them from the name lists. Last week's alias then cannot collide with this week's, and it is never registered as a gamertag to screen.
- `seasonForWeek` picked the first season overlapping the week on ANY server, including a retired test server.

- [ ] **Step 1: Write the failing tests**

Append to `test/story/context.test.ts`, inside the `describe`:

```ts
  it("rewrites last episode's redaction aliases into prose so they cannot collide with this week's", async () => {
    const storylines = [{ title: "REDACTED_PLAYER_1 strikes", players: ["REDACTED_PLAYER_1", "GoldSkull588"], clans: ["REDACTED_CLAN_2", "SNA"], status: "REDACTED_CLAN_2 hides", openQuestions: ["Will REDACTED_PLAYER_1 return?"] }];
    await fx.episode({ weekStart: PREV_MON, episodeNumber: 2, title: "Knives Out", storylines, narrative: "Boris: hi" });
    const { context, texts } = await buildStoryContext(db, { weekStart: MON, staffTags: [], previous: "db" });
    const s = context.previous!.storylines[0]!;
    expect(s.players).toEqual(["GoldSkull588"]);
    expect(s.clans).toEqual(["SNA"]);
    expect(s.title).toBe("a player whose name we cannot say strikes");
    expect(s.status).toBe("a clan we can't name hides");
    expect(s.openQuestions).toEqual(["Will a player whose name we cannot say return?"]);
    expect(JSON.stringify(context)).not.toMatch(/REDACTED_/u);
    expect(texts.entries().map((e) => e.text).sort()).toEqual(["GoldSkull588", "SNA"]);
  });
```

Create `test/story/season.test.ts`:

```ts
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { sql } from "drizzle-orm";
import { seasons, servers, type Database } from "@factions/db";
import { openDb, makeFixture, MON, type Fx } from "../fixture.js";
import { seasonForWeek } from "../../src/story/season.js";

describe("seasonForWeek", () => {
  let db: Database; let fx: Fx;
  beforeAll(async () => { db = await openDb(); });
  beforeEach(async () => { fx = await makeFixture(db); });

  it("ignores a season on an inactive server, even an earlier-starting one", async () => {
    const [old] = await db.insert(servers).values({ name: "OLD", map: "livonia", clockOffsetMs: 0, active: false }).returning();
    await db.insert(seasons).values({ serverId: old!.id, number: 9, startedAt: new Date("2026-08-01T00:00:00Z") });
    const s = await seasonForWeek(db, MON);
    expect(s).toMatchObject({ id: fx.seasonId, serverId: fx.serverId, number: 1 });
  });

  it("still throws NoSeasonError when only an inactive server has a season", async () => {
    await db.execute(sql`update servers set active = false`);
    await expect(seasonForWeek(db, MON)).rejects.toThrow(/no season covers/u);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd apps/show && TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions" npx vitest run test/story/context.test.ts test/story/season.test.ts`

Expected: FAIL. The alias test sees `REDACTED_PLAYER_1` in `players`, and the season test gets `number: 9`.

- [ ] **Step 3: Implement**

In `src/story/season.ts`, replace the query:

```ts
  // ⚠️ Active servers only: a retired server's season still overlaps the calendar, and an
  // earlier start would win the `order by` and put its week on air.
  const [r] = await rows<{ id: number; server_id: number; number: number; started_at: string | Date }>(db, sql`
    select s.id::int as id, s.server_id, s.number, s.started_at from seasons s
    join servers sv on sv.id = s.server_id and sv.active
    where s.started_at < ${tsz(to)} and (s.ended_at is null or s.ended_at > ${tsz(from)})
    order by s.started_at asc limit 1`);
```

In `src/story/context.ts`, add above `buildStoryContext`:

```ts
const PREV_PLAYER_ALIAS = /REDACTED_PLAYER_\d+/gu;
const PREV_CLAN_ALIAS = /REDACTED_CLAN_\d+/gu;
const IS_ALIAS = /^REDACTED_(?:PLAYER|CLAN)_\d+$/u;

/**
 * ⚠️ Last episode's aliases were numbered for last episode. This episode's redaction numbers
 * its own from 1, so a surviving `REDACTED_PLAYER_1` would name two different people in one
 * prompt. Rewritten to prose, they cannot collide and are never screened as gamertags.
 */
export function neutralizeAliases(s: string): string {
  return s.replace(PREV_PLAYER_ALIAS, "a player whose name we cannot say").replace(PREV_CLAN_ALIAS, "a clan we can't name");
}
```

and replace the `previous` construction with:

```ts
  const previous = lastEpisode === null ? null : {
    title: neutralizeAliases(lastEpisode.title),
    storylines: lastEpisode.storylines.map((s) => ({
      title: neutralizeAliases(s.title),
      status: neutralizeAliases(s.status),
      openQuestions: s.openQuestions.map(neutralizeAliases),
      players: s.players.filter((p) => !IS_ALIAS.test(p)).map((p) => texts.gamertag(p)),
      clans: s.clans.filter((c) => !IS_ALIAS.test(c)).map((c) => texts.clanTag(c)),
    })),
  };
```

(If the `Storyline` type has other fields, spread `...s` first and override these five.)

- [ ] **Step 4: Run to verify they pass**

Run the same command. Expected: PASS, including the existing context tests.

- [ ] **Step 5: Commit**

```bash
git add apps/show/src/story/context.ts apps/show/src/story/season.ts apps/show/test/story/context.test.ts apps/show/test/story/season.test.ts
git commit -m "fix(show): last episode's aliases become prose; seasons on active servers only"
```

---

### Task 2: Service configuration

**Files:**
- Modify: `apps/show/src/config.ts`
- Test: `apps/show/test/config.test.ts`

**Interfaces:**
- Consumes: `loadConfig`, `loadRenderConfig` (unchanged).
- Produces:

```ts
export const SHOW_LOCK_KEY = 8_531_208;
export type ServiceConfig =
  | { enabled: false; databaseUrl: string }
  | {
      enabled: true;
      databaseUrl: string;
      base: ShowConfig;
      render: RenderConfig;
      discordToken: string;
      guildId: string;
      opsChannelId: string | null;
      forumChannelId: string;
      requireApproval: boolean;
      approverIds: string[];
      youtube: { clientId: string; clientSecret: string; refreshToken: string; playlistId: string };
      facebook: { pageId: string; accessToken: string } | null;
    };
export function loadServiceConfig(env?: NodeJS.ProcessEnv): ServiceConfig;
```

- [ ] **Step 1: Write the failing tests**

Append to `test/config.test.ts`:

```ts
import { loadServiceConfig, SHOW_LOCK_KEY } from "../src/config.js";

const full = {
  DATABASE_URL: "postgres://db", OPENROUTER_API_KEY: "k", SHOW_ENABLED: "1",
  ELEVENLABS_API_KEY: "e", ELEVENLABS_BORIS_VOICE_ID: "b", ELEVENLABS_PAVEL_VOICE_ID: "p",
  DISCORD_TOKEN: "t", DISCORD_GUILD_ID: "111111111111111111", OPS_CHANNEL_ID: "222222222222222222",
  SHOW_FORUM_CHANNEL_ID: "1553136654808784986", SHOW_APPROVER_DISCORD_IDS: "333333333333333333, 444444444444444444",
  YOUTUBE_CLIENT_ID: "ci", YOUTUBE_CLIENT_SECRET: "cs", YOUTUBE_REFRESH_TOKEN: "rt", YOUTUBE_PLAYLIST_ID: "PL1",
};

describe("loadServiceConfig", () => {
  it("is off by default and then needs only DATABASE_URL", () => {
    expect(loadServiceConfig({ DATABASE_URL: "postgres://db" })).toEqual({ enabled: false, databaseUrl: "postgres://db" });
    expect(loadServiceConfig({ DATABASE_URL: "postgres://db", SHOW_ENABLED: "0" }).enabled).toBe(false);
  });

  it("reads a full enabled config with approval on by default", () => {
    const c = loadServiceConfig(full);
    if (!c.enabled) throw new Error("expected enabled");
    expect(c).toMatchObject({
      guildId: "111111111111111111", opsChannelId: "222222222222222222", forumChannelId: "1553136654808784986",
      requireApproval: true, approverIds: ["333333333333333333", "444444444444444444"],
      youtube: { clientId: "ci", clientSecret: "cs", refreshToken: "rt", playlistId: "PL1" }, facebook: null,
    });
    expect(c.render.cacheDir).toBe("/var/lib/clan-wars-show");
  });

  it("accepts true/1 for SHOW_ENABLED and 0/false for SHOW_REQUIRE_APPROVAL", () => {
    const c = loadServiceConfig({ ...full, SHOW_ENABLED: "true", SHOW_REQUIRE_APPROVAL: "false", SHOW_APPROVER_DISCORD_IDS: "" });
    expect(c.enabled && c.requireApproval).toBe(false);
  });

  it.each([
    ["SHOW_FORUM_CHANNEL_ID"], ["DISCORD_TOKEN"], ["DISCORD_GUILD_ID"], ["YOUTUBE_REFRESH_TOKEN"], ["YOUTUBE_PLAYLIST_ID"], ["ELEVENLABS_API_KEY"],
  ])("fails when enabled without %s", (key) => {
    expect(() => loadServiceConfig({ ...full, [key]: "" })).toThrow(new RegExp(key, "u"));
  });

  it("fails when approval is on without OPS_CHANNEL_ID or approvers", () => {
    expect(() => loadServiceConfig({ ...full, OPS_CHANNEL_ID: "" })).toThrow(/OPS_CHANNEL_ID/u);
    expect(() => loadServiceConfig({ ...full, SHOW_APPROVER_DISCORD_IDS: "" })).toThrow(/SHOW_APPROVER_DISCORD_IDS/u);
  });

  it("rejects a snowflake that is not one", () => {
    expect(() => loadServiceConfig({ ...full, SHOW_APPROVER_DISCORD_IDS: "333333333333333333,bob" })).toThrow(/SHOW_APPROVER_DISCORD_IDS/u);
    expect(() => loadServiceConfig({ ...full, SHOW_FORUM_CHANNEL_ID: "forum" })).toThrow(/SHOW_FORUM_CHANNEL_ID/u);
  });

  it("wants both Facebook keys or neither", () => {
    const c = loadServiceConfig({ ...full, FACEBOOK_PAGE_ID: "9", FACEBOOK_PAGE_ACCESS_TOKEN: "fb" });
    expect(c.enabled && c.facebook).toEqual({ pageId: "9", accessToken: "fb" });
    expect(() => loadServiceConfig({ ...full, FACEBOOK_PAGE_ID: "9" })).toThrow(/FACEBOOK/u);
  });

  it("uses a lock key distinct from the bot's instance lock", () => {
    expect(SHOW_LOCK_KEY).toBe(8_531_208);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd apps/show && npx vitest run test/config.test.ts`

Expected: FAIL, `loadServiceConfig` is not exported.

- [ ] **Step 3: Implement**

Append to `src/config.ts`:

```ts
/** `pg_try_advisory_lock` key for a show run. ⚠️ Never the bot's 8_531_207 (apps/bot/src/instance-lock.ts). */
export const SHOW_LOCK_KEY = 8_531_208;

export type ServiceConfig =
  | { enabled: false; databaseUrl: string }
  | {
      enabled: true;
      databaseUrl: string;
      base: ShowConfig;
      render: RenderConfig;
      discordToken: string;
      guildId: string;
      opsChannelId: string | null;
      forumChannelId: string;
      requireApproval: boolean;
      approverIds: string[];
      youtube: { clientId: string; clientSecret: string; refreshToken: string; playlistId: string };
      facebook: { pageId: string; accessToken: string } | null;
    };

const SNOWFLAKE = /^\d{17,20}$/u;
const flag = (v: string | undefined, dflt: boolean): boolean => {
  const s = v?.trim().toLowerCase();
  if (!s) return dflt;
  return s === "1" || s === "true";
};
function snowflake(env: NodeJS.ProcessEnv, key: string): string {
  const v = required(env, key);
  if (!SNOWFLAKE.test(v)) throw new Error(`${key} must be a Discord id, got "${v}"`);
  return v;
}

/**
 * The scheduled service's config (spec §13). Off unless SHOW_ENABLED, and then it needs
 * nothing but DATABASE_URL, so the timer can be installed before the keys exist.
 */
export function loadServiceConfig(env: NodeJS.ProcessEnv = process.env): ServiceConfig {
  const databaseUrl = required(env, "DATABASE_URL");
  if (!flag(env.SHOW_ENABLED, false)) return { enabled: false, databaseUrl };

  const requireApproval = flag(env.SHOW_REQUIRE_APPROVAL, true);
  const opsRaw = env.OPS_CHANNEL_ID?.trim() || null;
  if (opsRaw !== null && !SNOWFLAKE.test(opsRaw)) throw new Error(`OPS_CHANNEL_ID must be a Discord id, got "${opsRaw}"`);
  // ⚠️ With approval on, the draft has nowhere to go without the ops channel, and no one can approve it without approvers.
  if (requireApproval && opsRaw === null) throw new Error("OPS_CHANNEL_ID is required while SHOW_REQUIRE_APPROVAL is on");
  const approverIds = (env.SHOW_APPROVER_DISCORD_IDS ?? "").split(",").map((s) => s.trim()).filter((s) => s !== "");
  for (const id of approverIds) if (!SNOWFLAKE.test(id)) throw new Error(`SHOW_APPROVER_DISCORD_IDS: "${id}" is not a Discord id`);
  if (requireApproval && approverIds.length === 0) throw new Error("SHOW_APPROVER_DISCORD_IDS is required while SHOW_REQUIRE_APPROVAL is on");

  const pageId = env.FACEBOOK_PAGE_ID?.trim() || "";
  const pageToken = env.FACEBOOK_PAGE_ACCESS_TOKEN?.trim() || "";
  if (Boolean(pageId) !== Boolean(pageToken)) throw new Error("FACEBOOK_PAGE_ID and FACEBOOK_PAGE_ACCESS_TOKEN go together: set both or neither");

  return {
    enabled: true,
    databaseUrl,
    base: loadConfig(env),
    render: loadRenderConfig(env),
    discordToken: required(env, "DISCORD_TOKEN"),
    guildId: snowflake(env, "DISCORD_GUILD_ID"),
    opsChannelId: opsRaw,
    forumChannelId: snowflake(env, "SHOW_FORUM_CHANNEL_ID"),
    requireApproval,
    approverIds,
    youtube: {
      clientId: required(env, "YOUTUBE_CLIENT_ID"),
      clientSecret: required(env, "YOUTUBE_CLIENT_SECRET"),
      refreshToken: required(env, "YOUTUBE_REFRESH_TOKEN"),
      playlistId: required(env, "YOUTUBE_PLAYLIST_ID"),
    },
    facebook: pageId ? { pageId, accessToken: pageToken } : null,
  };
}
```

- [ ] **Step 4: Run to verify they pass**

Run: `cd apps/show && npx vitest run test/config.test.ts && npx tsc --noEmit -p .`

Expected: PASS, and tsc is clean.

- [ ] **Step 5: Commit**

```bash
git add apps/show/src/config.ts apps/show/test/config.test.ts
git commit -m "feat(show): service config for publishing and approval"
```

---

### Task 3: The episode row store and the week picker

**Files:**
- Create: `apps/show/src/stages/store.ts`, `apps/show/src/stages/pick.ts`
- Test: `apps/show/test/stages/store.test.ts`, `apps/show/test/stages/pick.test.ts`

**Interfaces:**
- Consumes: `seasonForWeek`, `NoSeasonError` (`src/story/season.ts`); `episodeNumber`, `lastEndedWeek`, `WEEK_MS` (`src/weeks.ts`); `showEpisodes`, `seasons`, `events` (`@factions/db`); `ShowStage` (`@factions/domain`).
- Produces:

```ts
// store.ts
export type EpisodeRow = typeof showEpisodes.$inferSelect;
export type EpisodeFields = Partial<Omit<EpisodeRow, "weekStart" | "seasonId" | "seasonNumber" | "episodeNumber" | "createdAt">>;
export const TERMINAL_STAGES: readonly ShowStage[]; // ["done", "held", "rejected"]
export async function getEpisode(db: Database, weekStart: Date): Promise<EpisodeRow | null>;
export async function createEpisode(db: Database, weekStart: Date): Promise<EpisodeRow>;
export async function advance(db: Database, weekStart: Date, stage: ShowStage, fields?: EpisodeFields): Promise<EpisodeRow>;
export async function setFields(db: Database, weekStart: Date, fields: EpisodeFields): Promise<EpisodeRow>;
export async function recordFailure(db: Database, weekStart: Date, error: string): Promise<number>;
export type ForceResult = "reset" | "missing" | "public-needs-repost";
export async function forceWeek(db: Database, weekStart: Date, opts: { repost: boolean }): Promise<ForceResult>;
// pick.ts
export const INGEST_GRACE_MS: number; // 6 h
export async function pickWeek(db: Database, now: Date): Promise<Date | null>;
```

Test fixture notes:
- `makeFixture` (`test/fixture.ts`) truncates `show_episodes` and seeds one season starting `SEASON_START` (2026-09-08T00:39:17Z), so `MON` (2026-09-21) is E03.
- `fx.episode(...)` inserts a row; `fx.event(type, at)` inserts an event.
- `seasons.week_closed_through` is null in the fixture; tests set it with `update seasons`.

- [ ] **Step 1: Write the failing store tests**

Create `test/stages/store.test.ts`:

```ts
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import type { Database } from "@factions/db";
import { openDb, makeFixture, MON, type Fx } from "../fixture.js";
import { advance, createEpisode, forceWeek, getEpisode, recordFailure, setFields } from "../../src/stages/store.js";

describe("episode store", () => {
  let db: Database; let fx: Fx;
  beforeAll(async () => { db = await openDb(); });
  beforeEach(async () => { fx = await makeFixture(db); });

  it("creates the row once, freezing season and episode numbers", async () => {
    const a = await createEpisode(db, MON);
    const b = await createEpisode(db, MON);
    expect(a).toMatchObject({ stage: "new", seasonId: fx.seasonId, seasonNumber: 1, episodeNumber: 3, attempts: 0 });
    expect(b.createdAt.getTime()).toBe(a.createdAt.getTime());
  });

  it("advance moves the stage, writes fields and clears the failure count", async () => {
    await createEpisode(db, MON);
    await recordFailure(db, MON, "boom");
    const r = await advance(db, MON, "context", { context: { x: 1 } });
    expect(r).toMatchObject({ stage: "context", context: { x: 1 }, attempts: 0, lastError: null });
  });

  it("setFields writes without moving the stage", async () => {
    await createEpisode(db, MON);
    const r = await setFields(db, MON, { youtubeVideoId: "vid" });
    expect(r).toMatchObject({ stage: "new", youtubeVideoId: "vid" });
  });

  it("recordFailure counts and keeps the latest error", async () => {
    await createEpisode(db, MON);
    expect(await recordFailure(db, MON, "one")).toBe(1);
    expect(await recordFailure(db, MON, "two")).toBe(2);
    expect((await getEpisode(db, MON))!.lastError).toBe("two");
  });

  it("forceWeek resets a held row to new, clearing everything after it", async () => {
    await fx.episode({ weekStart: MON, episodeNumber: 3, title: null, storylines: null, narrative: null, stage: "held" });
    await setFields(db, MON, { context: { x: 1 }, screeningReport: { r: 1 }, attempts: 2, lastError: "e" });
    expect(await forceWeek(db, MON, { repost: false })).toBe("reset");
    expect(await getEpisode(db, MON)).toMatchObject({ stage: "new", context: null, narrative: null, screeningReport: null, attempts: 0, lastError: null });
  });

  it("forceWeek refuses a public episode without --repost and changes nothing", async () => {
    await fx.episode({ weekStart: MON, episodeNumber: 3, title: "T", storylines: [], narrative: "Boris: hi", stage: "posted" });
    await setFields(db, MON, { youtubeVideoId: "vid", youtubePublicAt: new Date(), forumThreadId: "th" });
    expect(await forceWeek(db, MON, { repost: false })).toBe("public-needs-repost");
    expect(await getEpisode(db, MON)).toMatchObject({ stage: "posted", narrative: "Boris: hi", forumThreadId: "th" });
  });

  it("forceWeek with --repost clears the published ids too", async () => {
    await fx.episode({ weekStart: MON, episodeNumber: 3, title: "T", storylines: [], narrative: "Boris: hi", stage: "done" });
    await setFields(db, MON, { youtubeVideoId: "vid", youtubePublicAt: new Date(), forumThreadId: "th", discordPostedAt: new Date(), facebookVideoId: "fb", draftMessageId: "d", approvedByDiscordId: "a", approvedAt: new Date() });
    expect(await forceWeek(db, MON, { repost: true })).toBe("reset");
    expect(await getEpisode(db, MON)).toMatchObject({
      stage: "new", youtubeVideoId: null, youtubePublicAt: null, forumThreadId: null, discordPostedAt: null,
      facebookVideoId: null, draftMessageId: null, approvedByDiscordId: null, approvedAt: null,
    });
  });

  it("forceWeek on a missing row says so", async () => {
    expect(await forceWeek(db, MON, { repost: false })).toBe("missing");
  });
});
```

- [ ] **Step 2: Write the failing picker tests**

Create `test/stages/pick.test.ts`:

```ts
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { sql } from "drizzle-orm";
import type { Database } from "@factions/db";
import { openDb, makeFixture, MON, PREV_MON, at, type Fx } from "../fixture.js";
import { pickWeek } from "../../src/stages/pick.js";

const WEEK_END = at(7); // MON + 7 d, 2026-09-28
const closeThrough = (db: Database, d: Date) => db.execute(sql`update seasons set week_closed_through = ${d.toISOString()}::timestamptz`);

describe("pickWeek", () => {
  let db: Database; let fx: Fx;
  beforeAll(async () => { db = await openDb(); });
  beforeEach(async () => { fx = await makeFixture(db); });

  it("picks the last ended week once it is closed and ingest has passed its end", async () => {
    await closeThrough(db, MON);
    await fx.event("player.connected", at(7, 0, 5));
    expect((await pickWeek(db, at(7, 1)))?.toISOString()).toBe(MON.toISOString());
  });

  it("waits while the week is not closed", async () => {
    await closeThrough(db, PREV_MON);
    await fx.event("player.connected", at(7, 0, 5));
    expect(await pickWeek(db, at(7, 1))).toBeNull();
  });

  it("waits while ingest is behind and it is under 6 h past the week's end", async () => {
    await closeThrough(db, MON);
    await fx.event("player.connected", at(6, 23));
    expect(await pickWeek(db, at(7, 5, 59))).toBeNull();
  });

  it("goes out on an empty server once 6 h have passed", async () => {
    await closeThrough(db, MON);
    expect((await pickWeek(db, at(7, 6)))?.toISOString()).toBe(MON.toISOString());
  });

  it("prefers the earliest unfinished row over a new week", async () => {
    await closeThrough(db, MON);
    await fx.episode({ weekStart: PREV_MON, episodeNumber: 2, title: null, storylines: null, narrative: null, stage: "context" });
    expect((await pickWeek(db, at(7, 7)))?.toISOString()).toBe(PREV_MON.toISOString());
  });

  it("skips terminal rows and never picks a week that already has one", async () => {
    await closeThrough(db, MON);
    await fx.episode({ weekStart: PREV_MON, episodeNumber: 2, title: null, storylines: null, narrative: null, stage: "held" });
    await fx.episode({ weekStart: MON, episodeNumber: 3, title: "T", storylines: [], narrative: "Boris: hi", stage: "done" });
    expect(await pickWeek(db, at(7, 7))).toBeNull();
  });

  it("never backfills an older week with no row", async () => {
    await closeThrough(db, MON);
    await fx.episode({ weekStart: MON, episodeNumber: 3, title: "T", storylines: [], narrative: "Boris: hi", stage: "done" });
    expect(await pickWeek(db, at(7, 7))).toBeNull(); // PREV_MON has no row and stays that way
  });
});
```

- [ ] **Step 3: Run to verify they fail**

Run: `cd apps/show && TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions" npx vitest run test/stages`

Expected: FAIL, the modules do not exist.

- [ ] **Step 4: Implement `src/stages/store.ts`**

```ts
import { and, eq, sql } from "drizzle-orm";
import { showEpisodes, type Database } from "@factions/db";
import type { ShowStage } from "@factions/domain";
import { seasonForWeek } from "../story/season.js";
import { episodeNumber } from "../weeks.js";

export type EpisodeRow = typeof showEpisodes.$inferSelect;
export type EpisodeFields = Partial<Omit<EpisodeRow, "weekStart" | "seasonId" | "seasonNumber" | "episodeNumber" | "createdAt">>;

/** Stages a run never leaves on its own: `held` and `rejected` wait for an operator (spec §8.2). */
export const TERMINAL_STAGES: readonly ShowStage[] = ["done", "held", "rejected"];

export async function getEpisode(db: Database, weekStart: Date): Promise<EpisodeRow | null> {
  const [r] = await db.select().from(showEpisodes).where(eq(showEpisodes.weekStart, weekStart));
  return r ?? null;
}

/** The `new` stage (spec §8.2): S and E are frozen here and never recomputed. Idempotent. */
export async function createEpisode(db: Database, weekStart: Date): Promise<EpisodeRow> {
  const season = await seasonForWeek(db, weekStart);
  await db.insert(showEpisodes).values({
    weekStart, seasonId: season.id, seasonNumber: season.number,
    episodeNumber: episodeNumber(season.startedAt, weekStart), stage: "new",
  }).onConflictDoNothing();
  return (await getEpisode(db, weekStart))!;
}

async function write(db: Database, weekStart: Date, set: Record<string, unknown>): Promise<EpisodeRow> {
  const [r] = await db.update(showEpisodes).set({ ...set, updatedAt: new Date() }).where(eq(showEpisodes.weekStart, weekStart)).returning();
  if (!r) throw new Error(`no show_episodes row for ${weekStart.toISOString()}`);
  return r;
}

/** A stage finished: record it, with what it wrote, and start the next stage's failure count at 0. */
export function advance(db: Database, weekStart: Date, stage: ShowStage, fields: EpisodeFields = {}): Promise<EpisodeRow> {
  return write(db, weekStart, { attempts: 0, lastError: null, ...fields, stage });
}

/** Mid-stage progress (an id written right after its post), without finishing the stage. */
export function setFields(db: Database, weekStart: Date, fields: EpisodeFields): Promise<EpisodeRow> {
  return write(db, weekStart, fields);
}

/** Returns the new attempt count at the current stage. */
export async function recordFailure(db: Database, weekStart: Date, error: string): Promise<number> {
  const r = await write(db, weekStart, { attempts: sql`${showEpisodes.attempts} + 1`, lastError: error.slice(0, 2000) });
  return r.attempts;
}

export type ForceResult = "reset" | "missing" | "public-needs-repost";

/**
 * `--force` (spec §10): back to `new`, so the next run rebuilds the context (an operator's new
 * override applies) and writes a new script. ⚠️ A public episode needs `--repost`, which also
 * clears the forum and Facebook ids so the new cut is posted rather than silently skipped.
 * The old unlisted or public YouTube video is left where it is.
 */
export async function forceWeek(db: Database, weekStart: Date, opts: { repost: boolean }): Promise<ForceResult> {
  const row = await getEpisode(db, weekStart);
  if (!row) return "missing";
  if (row.youtubePublicAt !== null && !opts.repost) return "public-needs-repost";
  const cleared: EpisodeFields = {
    context: null, narrative: null, storylines: null, title: null, screeningReport: null,
    youtubeVideoId: null, draftMessageId: null, approvedByDiscordId: null, approvedAt: null,
    rejectedByDiscordId: null, rejectedAt: null, youtubePublicAt: null,
    forumThreadId: null, discordPostedAt: null, facebookVideoId: null, facebookPostedAt: null,
  };
  await db.update(showEpisodes).set({ ...cleared, stage: "new", attempts: 0, lastError: null, updatedAt: new Date() })
    .where(and(eq(showEpisodes.weekStart, weekStart)));
  return "reset";
}
```

- [ ] **Step 5: Implement `src/stages/pick.ts`**

```ts
import { sql } from "drizzle-orm";
import type { Database } from "@factions/db";
import { NoSeasonError, seasonForWeek } from "../story/season.js";
import { rows, tsz } from "../story/sql.js";
import { lastEndedWeek, WEEK_MS } from "../weeks.js";

/** An empty server logs nothing; after this long past week end the show goes out anyway (spec §8.1). */
export const INGEST_GRACE_MS = 6 * 3_600_000;

async function ready(db: Database, weekStart: Date, now: Date): Promise<boolean> {
  let season;
  try {
    season = await seasonForWeek(db, weekStart);
  } catch (e) {
    if (e instanceof NoSeasonError) return false;
    throw e;
  }
  const weekEnd = new Date(weekStart.getTime() + WEEK_MS);
  const [r] = await rows<{ closed: boolean; caught_up: boolean }>(db, sql`
    select
      coalesce((select week_closed_through >= ${tsz(weekStart)} from seasons where id = ${season.id}), false) as closed,
      exists(select 1 from events where server_id = ${season.serverId} and occurred_at >= ${tsz(weekEnd)}) as caught_up`);
  // ⚠️ Both: standings and Alphas must be final (the week close), and ingest must have
  // reached the end of the week, or a late raid is missing from the episode forever.
  return Boolean(r?.closed) && (Boolean(r?.caught_up) || now.getTime() >= weekEnd.getTime() + INGEST_GRACE_MS);
}

/**
 * Spec §8.1: the earliest unfinished row, else the most recent ended week with no row once it
 * is ready. ⚠️ Never an older week with no row: weeks before launch are not backfilled (the
 * runbook seeds one with `--week` if wanted).
 */
export async function pickWeek(db: Database, now: Date): Promise<Date | null> {
  const [open] = await rows<{ week_start: string | Date }>(db, sql`
    select week_start from show_episodes where stage not in ('done', 'held', 'rejected') order by week_start asc limit 1`);
  if (open) return new Date(open.week_start);
  const candidate = lastEndedWeek(now);
  const [taken] = await rows<{ one: number }>(db, sql`select 1 as one from show_episodes where week_start = ${tsz(candidate)}`);
  if (taken) return null;
  return (await ready(db, candidate, now)) ? candidate : null;
}
```

- [ ] **Step 6: Run to verify they pass**

Run: `cd apps/show && TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions" npx vitest run test/stages && npx tsc --noEmit -p .`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/show/src/stages apps/show/test/stages
git commit -m "feat(show): episode row store and week picker"
```

---

### Task 4: Discord REST client

**Files:**
- Create: `apps/show/src/engine/publish/discord.ts`
- Modify: `apps/show/test/engine/boundary.test.ts` (add `"stages"` to `FORBIDDEN_DIRS`)
- Test: `apps/show/test/engine/publish/discord.test.ts`

**Interfaces:**
- Produces:

```ts
export const DISCORD_API = "https://discord.com/api/v10";
export const DISCORD_USER_AGENT = "DiscordBot (https://dayzclanwars.com, 1.0)";
export type DiscordFile = { name: string; data: Buffer; contentType: string };
export type DiscordEmbed = { description: string; title?: string };
export type OutMessage = { content?: string; embeds?: DiscordEmbed[]; files?: DiscordFile[] };
export type SeenMessage = { id: string; content: string; authorId: string; embeds: number; attachments: number };
export type Discord = {
  me(): Promise<string>;
  post(channelId: string, msg: OutMessage): Promise<{ id: string }>;
  react(channelId: string, messageId: string, emoji: string): Promise<void>;
  reactionUserIds(channelId: string, messageId: string, emoji: string): Promise<string[]>;
  recentMessages(channelId: string, limit?: number): Promise<SeenMessage[]>;
  createForumThread(forumId: string, name: string, msg: OutMessage): Promise<{ threadId: string }>;
  findForumThread(guildId: string, forumId: string, name: string): Promise<string | null>;
};
export function createDiscord(deps: { token: string; fetchImpl?: typeof fetch; sleep?: (ms: number) => Promise<void> }): Discord;
```

- [ ] **Step 1: Write the failing tests**

Create `test/engine/publish/discord.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { createDiscord, DISCORD_USER_AGENT } from "../../../src/engine/publish/discord.js";

type Call = { url: string; init: RequestInit };
function fakeFetch(replies: Array<{ status: number; body?: unknown }>) {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const r = replies.shift() ?? { status: 200, body: {} };
    return new Response(r.status === 204 ? null : JSON.stringify(r.body ?? {}), { status: r.status });
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}
const headers = (c: Call) => new Headers(c.init.headers);

describe("createDiscord", () => {
  it("posts JSON with the bot token, a User-Agent and no mentions", async () => {
    const { calls, fetchImpl } = fakeFetch([{ status: 200, body: { id: "m1" } }]);
    const d = createDiscord({ token: "T", fetchImpl });
    expect(await d.post("c1", { content: "hi @everyone" })).toEqual({ id: "m1" });
    expect(calls[0]!.url).toBe("https://discord.com/api/v10/channels/c1/messages");
    expect(headers(calls[0]!).get("authorization")).toBe("Bot T");
    expect(headers(calls[0]!).get("user-agent")).toBe(DISCORD_USER_AGENT);
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({ content: "hi @everyone", allowed_mentions: { parse: [] } });
  });

  it("posts files as multipart with payload_json", async () => {
    const { calls, fetchImpl } = fakeFetch([{ status: 200, body: { id: "m2" } }]);
    const d = createDiscord({ token: "T", fetchImpl });
    await d.post("c1", { content: "x", files: [{ name: "episode.mp3", data: Buffer.from("MP3"), contentType: "audio/mpeg" }] });
    const form = calls[0]!.init.body as FormData;
    expect(JSON.parse(form.get("payload_json") as string)).toEqual({ content: "x", allowed_mentions: { parse: [] }, attachments: [{ id: 0, filename: "episode.mp3" }] });
    expect((form.get("files[0]") as File).name).toBe("episode.mp3");
    expect(headers(calls[0]!).get("content-type")).toBeNull(); // fetch sets the multipart boundary itself
  });

  it("waits out a 429 and retries", async () => {
    const waits: number[] = [];
    const { calls, fetchImpl } = fakeFetch([{ status: 429, body: { retry_after: 1.5 } }, { status: 200, body: { id: "m3" } }]);
    const d = createDiscord({ token: "T", fetchImpl, sleep: async (ms) => { waits.push(ms); } });
    expect(await d.post("c1", { content: "x" })).toEqual({ id: "m3" });
    expect(calls).toHaveLength(2);
    expect(waits[0]).toBe(1750);
  });

  it("throws on any other failure with the status", async () => {
    const { fetchImpl } = fakeFetch([{ status: 403, body: { message: "Missing Access" } }]);
    await expect(createDiscord({ token: "T", fetchImpl }).post("c1", { content: "x" })).rejects.toThrow(/403/u);
  });

  it("reads reaction users for a url-encoded emoji", async () => {
    const { calls, fetchImpl } = fakeFetch([{ status: 200, body: [{ id: "u1" }, { id: "u2" }] }]);
    expect(await createDiscord({ token: "T", fetchImpl }).reactionUserIds("c", "m", "✅")).toEqual(["u1", "u2"]);
    expect(calls[0]!.url).toBe(`https://discord.com/api/v10/channels/c/messages/m/reactions/${encodeURIComponent("✅")}?limit=100`);
  });

  it("adds a reaction with PUT to @me", async () => {
    const { calls, fetchImpl } = fakeFetch([{ status: 204 }]);
    await createDiscord({ token: "T", fetchImpl }).react("c", "m", "❌");
    expect(calls[0]!.init.method).toBe("PUT");
    expect(calls[0]!.url).toBe(`https://discord.com/api/v10/channels/c/messages/m/reactions/${encodeURIComponent("❌")}/@me`);
  });

  it("maps recent messages to their author, embed and attachment counts", async () => {
    const { fetchImpl } = fakeFetch([{ status: 200, body: [{ id: "1", content: "a", author: { id: "bot" }, embeds: [{}], attachments: [{}, {}] }] }]);
    expect(await createDiscord({ token: "T", fetchImpl }).recentMessages("c", 10)).toEqual([{ id: "1", content: "a", authorId: "bot", embeds: 1, attachments: 2 }]);
  });

  it("creates a forum thread whose first message is the given one", async () => {
    const { calls, fetchImpl } = fakeFetch([{ status: 201, body: { id: "th1" } }]);
    expect(await createDiscord({ token: "T", fetchImpl }).createForumThread("f", "Clan Wars S01E03 · T", { content: "https://youtu.be/v" })).toEqual({ threadId: "th1" });
    expect(calls[0]!.url).toBe("https://discord.com/api/v10/channels/f/threads");
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({ name: "Clan Wars S01E03 · T", message: { content: "https://youtu.be/v", allowed_mentions: { parse: [] } } });
  });

  it("finds a forum thread by exact name among active, then archived, threads", async () => {
    const { calls, fetchImpl } = fakeFetch([
      { status: 200, body: { threads: [{ id: "x", parent_id: "other", name: "N" }] } },
      { status: 200, body: { threads: [{ id: "t9", parent_id: "f", name: "N" }], has_more: false } },
    ]);
    expect(await createDiscord({ token: "T", fetchImpl }).findForumThread("g", "f", "N")).toBe("t9");
    expect(calls[0]!.url).toBe("https://discord.com/api/v10/guilds/g/threads/active");
    expect(calls[1]!.url).toBe("https://discord.com/api/v10/channels/f/threads/archived/public?limit=100");
  });

  it("returns null when no thread has the name", async () => {
    const { fetchImpl } = fakeFetch([{ status: 200, body: { threads: [] } }, { status: 200, body: { threads: [], has_more: false } }]);
    expect(await createDiscord({ token: "T", fetchImpl }).findForumThread("g", "f", "N")).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd apps/show && npx vitest run test/engine/publish/discord.test.ts`

Expected: FAIL, the module is missing.

- [ ] **Step 3: Implement `src/engine/publish/discord.ts`**

```ts
export const DISCORD_API = "https://discord.com/api/v10";
/** ⚠️ Discord's Cloudflare front rejects a request with no User-Agent (house memory: Discord post mechanics). */
export const DISCORD_USER_AGENT = "DiscordBot (https://dayzclanwars.com, 1.0)";

export type DiscordFile = { name: string; data: Buffer; contentType: string };
export type DiscordEmbed = { description: string; title?: string };
export type OutMessage = { content?: string; embeds?: DiscordEmbed[]; files?: DiscordFile[] };
export type SeenMessage = { id: string; content: string; authorId: string; embeds: number; attachments: number };
export type Discord = {
  me(): Promise<string>;
  post(channelId: string, msg: OutMessage): Promise<{ id: string }>;
  react(channelId: string, messageId: string, emoji: string): Promise<void>;
  reactionUserIds(channelId: string, messageId: string, emoji: string): Promise<string[]>;
  recentMessages(channelId: string, limit?: number): Promise<SeenMessage[]>;
  createForumThread(forumId: string, name: string, msg: OutMessage): Promise<{ threadId: string }>;
  findForumThread(guildId: string, forumId: string, name: string): Promise<string | null>;
};

// ⚠️ Gamertags and clan names are player-controlled; a message must never ping anyone.
const NO_MENTIONS = { parse: [] as string[] };

/** Bot-token REST, no gateway (spec §9.3). Retries a 429 after Discord's retry_after; any other non-2xx throws. */
export function createDiscord(deps: { token: string; fetchImpl?: typeof fetch; sleep?: (ms: number) => Promise<void> }): Discord {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  async function call<T>(method: string, path: string, body?: unknown, form?: FormData): Promise<T> {
    for (;;) {
      const headers: Record<string, string> = { Authorization: `Bot ${deps.token}`, "User-Agent": DISCORD_USER_AGENT };
      if (body !== undefined) headers["Content-Type"] = "application/json";
      const res = await fetchImpl(`${DISCORD_API}${path}`, { method, headers, body: form ?? (body === undefined ? undefined : JSON.stringify(body)) });
      if (res.status === 429) {
        const j = (await res.json().catch(() => ({}))) as { retry_after?: number };
        await sleep(Math.ceil(Number(j.retry_after ?? 1) * 1000) + 250);
        continue;
      }
      if (!res.ok) throw new Error(`Discord ${method} ${path} failed ${res.status}: ${(await res.text()).slice(0, 300)}`);
      return (res.status === 204 ? undefined : await res.json()) as T;
    }
  }

  const payload = (msg: OutMessage) => ({
    ...(msg.content !== undefined ? { content: msg.content } : {}),
    ...(msg.embeds?.length ? { embeds: msg.embeds } : {}),
    allowed_mentions: NO_MENTIONS,
  });

  return {
    async me() {
      return (await call<{ id: string }>("GET", "/users/@me")).id;
    },
    async post(channelId, msg) {
      if (!msg.files?.length) return call<{ id: string }>("POST", `/channels/${channelId}/messages`, payload(msg));
      const form = new FormData();
      form.append("payload_json", JSON.stringify({ ...payload(msg), attachments: msg.files.map((f, i) => ({ id: i, filename: f.name })) }));
      msg.files.forEach((f, i) => form.append(`files[${i}]`, new Blob([f.data], { type: f.contentType }), f.name));
      return call<{ id: string }>("POST", `/channels/${channelId}/messages`, undefined, form);
    },
    async react(channelId, messageId, emoji) {
      await call<void>("PUT", `/channels/${channelId}/messages/${messageId}/reactions/${encodeURIComponent(emoji)}/@me`);
    },
    async reactionUserIds(channelId, messageId, emoji) {
      const users = await call<{ id: string }[]>("GET", `/channels/${channelId}/messages/${messageId}/reactions/${encodeURIComponent(emoji)}?limit=100`);
      return users.map((u) => u.id);
    },
    async recentMessages(channelId, limit = 50) {
      const ms = await call<{ id: string; content: string; author: { id: string }; embeds?: unknown[]; attachments?: unknown[] }[]>("GET", `/channels/${channelId}/messages?limit=${limit}`);
      return ms.map((m) => ({ id: m.id, content: m.content, authorId: m.author.id, embeds: m.embeds?.length ?? 0, attachments: m.attachments?.length ?? 0 }));
    },
    async createForumThread(forumId, name, msg) {
      const t = await call<{ id: string }>("POST", `/channels/${forumId}/threads`, { name, message: payload(msg) });
      return { threadId: t.id };
    },
    async findForumThread(guildId, forumId, name) {
      type Threads = { threads: { id: string; parent_id: string; name: string }[] };
      const pick = (t: Threads) => t.threads.find((x) => x.parent_id === forumId && x.name === name)?.id ?? null;
      const active = pick(await call<Threads>("GET", `/guilds/${guildId}/threads/active`));
      if (active) return active;
      // One page of archived threads is ample: the show posts one thread a week.
      return pick(await call<Threads>("GET", `/channels/${forumId}/threads/archived/public?limit=100`));
    },
  };
}
```

In `test/engine/boundary.test.ts`, change `FORBIDDEN_DIRS` to include `"stages"`:

```ts
const FORBIDDEN_DIRS = ["story", "cards", "stores", "produce", "screening", "prompt", "script", "stages"].map((d) => path.join(SRC, d));
```

- [ ] **Step 4: Run to verify they pass**

Run: `cd apps/show && npx vitest run test/engine && npx tsc --noEmit -p .`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/show/src/engine/publish/discord.ts apps/show/test/engine
git commit -m "feat(show): Discord REST client for drafts, reactions and forum threads"
```

---

### Task 5: YouTube: the KOTH port plus privacy, playlist and find, and the auth script

**Files:**
- Create: `apps/show/src/engine/publish/youtube/youtube.ts`, `apps/show/src/engine/publish/youtube/buildVideoMeta.ts`, `apps/show/scripts/youtube-auth.ts`
- Test: `apps/show/test/engine/publish/youtube.test.ts`, `apps/show/test/engine/publish/buildVideoMeta.test.ts`

**Interfaces:**
- Consumes: KOTH `bot/src/youtube/youtube.js` and `buildVideoMeta.js` at `a5ef8e7` (port `accessTokenFromRefresh`, `uploadVideo` and `waitForVideoProcessed` with behavior unchanged; their KOTH tests move over as the first cases below).
- Produces:

```ts
// youtube.ts
export type Privacy = "public" | "unlisted" | "private";
export async function accessTokenFromRefresh(o: { clientId: string; clientSecret: string; refreshToken: string; fetchImpl?: typeof fetch }): Promise<string>;
export async function uploadVideo(o: { accessToken: string; filePath: string; title: string; description: string; privacy: Privacy; fetchImpl?: typeof fetch; fsImpl?: { readFileSync(p: string): Buffer } }): Promise<string>;
export async function waitForVideoProcessed(o: { accessToken: string; videoId: string; fetchImpl?: typeof fetch; intervalMs?: number; maxWaitMs?: number; now?: () => number; sleep?: (ms: number) => Promise<void> }): Promise<boolean>;
export async function setPrivacy(o: { accessToken: string; videoId: string; privacy: Privacy; fetchImpl?: typeof fetch }): Promise<void>;
export async function playlistHas(o: { accessToken: string; playlistId: string; videoId: string; fetchImpl?: typeof fetch }): Promise<boolean>;
export async function addToPlaylist(o: { accessToken: string; playlistId: string; videoId: string; fetchImpl?: typeof fetch }): Promise<void>;
export async function findUploadByTitle(o: { accessToken: string; title: string; fetchImpl?: typeof fetch }): Promise<string | null>;
// buildVideoMeta.ts
export const YOUTUBE_TITLE_MAX = 100;
export const YOUTUBE_DESCRIPTION_MAX = 5000;
export function videoTitle(code: string, subtitle: string): string;
export function buildVideoMeta(o: { code: string; subtitle: string; transcript: string }): { title: string; description: string };
```

- [ ] **Step 1: Write the failing tests**

Create `test/engine/publish/youtube.test.ts`. The first three `describe`s are the KOTH cases, ported (`test/youtube/youtube.test.ts` at `a5ef8e7`); port the KOTH `waitForVideoProcessed` cases verbatim too. Then add:

```ts
import { describe, it, expect } from "vitest";
import { accessTokenFromRefresh, uploadVideo, setPrivacy, playlistHas, addToPlaylist, findUploadByTitle } from "../../../src/engine/publish/youtube/youtube.js";

type Call = { url: string; init: RequestInit };
const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers });
function fake(replies: Response[]) {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string, init: RequestInit = {}) => { calls.push({ url, init }); return replies.shift() ?? json(200, {}); }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

describe("accessTokenFromRefresh (KOTH)", () => {
  it("POSTs the refresh_token grant and returns the access token", async () => {
    const { calls, fetchImpl } = fake([json(200, { access_token: "AT" })]);
    expect(await accessTokenFromRefresh({ clientId: "cid", clientSecret: "sec", refreshToken: "rt", fetchImpl })).toBe("AT");
    expect(calls[0]!.url).toBe("https://oauth2.googleapis.com/token");
    expect(String(calls[0]!.init.body)).toContain("grant_type=refresh_token");
  });
  it("throws on a non-ok token response", async () => {
    const { fetchImpl } = fake([json(400, { error: "invalid_grant" })]);
    await expect(accessTokenFromRefresh({ clientId: "c", clientSecret: "s", refreshToken: "r", fetchImpl })).rejects.toThrow(/invalid_grant|400/u);
  });
});

describe("uploadVideo (KOTH)", () => {
  it("opens a resumable session then PUTs the bytes, with the given privacy", async () => {
    const { calls, fetchImpl } = fake([json(200, {}, { location: "https://upload.session/uri" }), json(200, { id: "VID" })]);
    const id = await uploadVideo({ accessToken: "AT", filePath: "/x.mp4", title: "T", description: "D", privacy: "unlisted", fetchImpl, fsImpl: { readFileSync: () => Buffer.from("MP4") } });
    expect(id).toBe("VID");
    const meta = JSON.parse(calls[0]!.init.body as string);
    expect(meta).toEqual({ snippet: { title: "T", description: "D", categoryId: "20" }, status: { privacyStatus: "unlisted" } });
    expect(calls[1]!.url).toBe("https://upload.session/uri");
  });
});

describe("setPrivacy", () => {
  it("updates status.privacyStatus with part=status", async () => {
    const { calls, fetchImpl } = fake([json(200, { id: "VID" })]);
    await setPrivacy({ accessToken: "AT", videoId: "VID", privacy: "public", fetchImpl });
    expect(calls[0]!.url).toBe("https://www.googleapis.com/youtube/v3/videos?part=status");
    expect(calls[0]!.init.method).toBe("PUT");
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({ id: "VID", status: { privacyStatus: "public" } });
  });
  it("throws on failure", async () => {
    const { fetchImpl } = fake([json(403, { error: { message: "insufficientPermissions" } })]);
    await expect(setPrivacy({ accessToken: "AT", videoId: "V", privacy: "public", fetchImpl })).rejects.toThrow(/403/u);
  });
});

describe("playlists", () => {
  it("playlistHas asks for the one video in the playlist", async () => {
    const { calls, fetchImpl } = fake([json(200, { items: [{ id: "pi" }] }), json(200, { items: [] })]);
    expect(await playlistHas({ accessToken: "AT", playlistId: "PL", videoId: "V", fetchImpl })).toBe(true);
    expect(await playlistHas({ accessToken: "AT", playlistId: "PL", videoId: "V", fetchImpl })).toBe(false);
    expect(calls[0]!.url).toBe("https://www.googleapis.com/youtube/v3/playlistItems?part=id&playlistId=PL&videoId=V");
  });
  it("addToPlaylist inserts a playlistItem", async () => {
    const { calls, fetchImpl } = fake([json(200, { id: "pi" })]);
    await addToPlaylist({ accessToken: "AT", playlistId: "PL", videoId: "V", fetchImpl });
    expect(calls[0]!.url).toBe("https://www.googleapis.com/youtube/v3/playlistItems?part=snippet");
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({ snippet: { playlistId: "PL", resourceId: { kind: "youtube#video", videoId: "V" } } });
  });
});

describe("findUploadByTitle", () => {
  it("looks through the channel's uploads playlist for the exact title", async () => {
    const { calls, fetchImpl } = fake([
      json(200, { items: [{ contentDetails: { relatedPlaylists: { uploads: "UU1" } } }] }),
      json(200, { items: [{ snippet: { title: "Other", resourceId: { videoId: "a" } } }, { snippet: { title: "Wanted", resourceId: { videoId: "b" } } }] }),
    ]);
    expect(await findUploadByTitle({ accessToken: "AT", title: "Wanted", fetchImpl })).toBe("b");
    expect(calls[0]!.url).toBe("https://www.googleapis.com/youtube/v3/channels?part=contentDetails&mine=true");
    expect(calls[1]!.url).toBe("https://www.googleapis.com/youtube/v3/playlistItems?part=snippet&maxResults=50&playlistId=UU1");
  });
  it("returns null when no upload has the title", async () => {
    const { fetchImpl } = fake([json(200, { items: [{ contentDetails: { relatedPlaylists: { uploads: "UU1" } } }] }), json(200, { items: [] })]);
    expect(await findUploadByTitle({ accessToken: "AT", title: "Wanted", fetchImpl })).toBeNull();
  });
});
```

Create `test/engine/publish/buildVideoMeta.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { buildVideoMeta, videoTitle, YOUTUBE_DESCRIPTION_MAX } from "../../../src/engine/publish/youtube/buildVideoMeta.js";

describe("buildVideoMeta", () => {
  it("titles per spec §2.4 with a middle dot", () => {
    expect(videoTitle("S01E03", "The Curse")).toBe("The Bloodbag and Painkiller Show: Clan Wars S01E03 · The Curse");
  });
  it("keeps the title within YouTube's 100 characters by shortening the subtitle", () => {
    const t = videoTitle("S01E03", "x".repeat(80));
    expect(t.length).toBeLessThanOrEqual(100);
    expect(t.startsWith("The Bloodbag and Painkiller Show: Clan Wars S01E03 · ")).toBe(true);
  });
  it("strips markdown and the angle brackets YouTube refuses", () => {
    const m = buildVideoMeta({ code: "S01E03", subtitle: "A <b> C", transcript: "**BORIS**: `SNA` <3 _you_" });
    expect(m.title).not.toMatch(/[<>]/u);
    expect(m.description).toBe("BORIS: SNA 3 you");
  });
  it("caps the description at 5,000 characters with a notice", () => {
    const m = buildVideoMeta({ code: "S01E03", subtitle: "T", transcript: "a".repeat(9000) });
    expect(m.description.length).toBe(YOUTUBE_DESCRIPTION_MAX);
    expect(m.description.endsWith("[transcript truncated]")).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd apps/show && npx vitest run test/engine/publish`

Expected: FAIL, the modules are missing.

- [ ] **Step 3: Implement `src/engine/publish/youtube/youtube.ts`**

Port the KOTH file to TypeScript, keeping its constants and behavior: `TOKEN_URL`, `UPLOAD_URL`, `GAMING_CATEGORY_ID = "20"`, `STATUS_URL`, `POLL_INTERVAL_MS = 15_000`, `MAX_WAIT_MS = 6 * 60_000`, `accessTokenFromRefresh`, `uploadVideo` and `waitForVideoProcessed`. There is one change: `uploadVideo`'s `privacy` is required, because this app always uploads unlisted first. Then append:

```ts
const API = "https://www.googleapis.com/youtube/v3";

async function ytJson(fetchImpl: typeof fetch, what: string, url: string, init: RequestInit): Promise<any> {
  const res = await fetchImpl(url, init);
  const j = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`YouTube ${what} failed ${res.status}: ${JSON.stringify(j ?? {})}`);
  return j;
}
const auth = (accessToken: string, withBody = false): Record<string, string> =>
  withBody ? { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json; charset=UTF-8" } : { Authorization: `Bearer ${accessToken}` };

/** Needs the `youtube` scope (spec §9.1). ⚠️ videos.update replaces the whole `status` part; only privacy is set. */
export async function setPrivacy(o: { accessToken: string; videoId: string; privacy: Privacy; fetchImpl?: typeof fetch }): Promise<void> {
  await ytJson(o.fetchImpl ?? fetch, "videos.update", `${API}/videos?part=status`, {
    method: "PUT", headers: auth(o.accessToken, true), body: JSON.stringify({ id: o.videoId, status: { privacyStatus: o.privacy } }),
  });
}

export async function playlistHas(o: { accessToken: string; playlistId: string; videoId: string; fetchImpl?: typeof fetch }): Promise<boolean> {
  const q = new URLSearchParams({ part: "id", playlistId: o.playlistId, videoId: o.videoId });
  const j = await ytJson(o.fetchImpl ?? fetch, "playlistItems.list", `${API}/playlistItems?${q}`, { headers: auth(o.accessToken) });
  return (j?.items?.length ?? 0) > 0;
}

export async function addToPlaylist(o: { accessToken: string; playlistId: string; videoId: string; fetchImpl?: typeof fetch }): Promise<void> {
  await ytJson(o.fetchImpl ?? fetch, "playlistItems.insert", `${API}/playlistItems?part=snippet`, {
    method: "POST", headers: auth(o.accessToken, true),
    body: JSON.stringify({ snippet: { playlistId: o.playlistId, resourceId: { kind: "youtube#video", videoId: o.videoId } } }),
  });
}

/**
 * The upload that a crash between `uploadVideo` and the row write left behind (spec §8.3):
 * the newest 50 uploads, which include unlisted ones, matched on the exact title.
 */
export async function findUploadByTitle(o: { accessToken: string; title: string; fetchImpl?: typeof fetch }): Promise<string | null> {
  const fetchImpl = o.fetchImpl ?? fetch;
  const ch = await ytJson(fetchImpl, "channels.list", `${API}/channels?part=contentDetails&mine=true`, { headers: auth(o.accessToken) });
  const uploads: string | undefined = ch?.items?.[0]?.contentDetails?.relatedPlaylists?.uploads;
  if (!uploads) throw new Error("YouTube channels.list: no uploads playlist for this token's channel");
  const q = new URLSearchParams({ part: "snippet", maxResults: "50", playlistId: uploads });
  const items = await ytJson(fetchImpl, "playlistItems.list", `${API}/playlistItems?${q}`, { headers: auth(o.accessToken) });
  const hit = (items?.items ?? []).find((i: any) => i?.snippet?.title === o.title);
  return hit?.snippet?.resourceId?.videoId ?? null;
}
```

(The `any` casts are confined to response parsing. If the repo's lint forbids `any`, use `unknown` with narrow type guards instead; tests are unchanged.)

- [ ] **Step 4: Implement `src/engine/publish/youtube/buildVideoMeta.ts`**

```ts
export const YOUTUBE_TITLE_MAX = 100;
export const YOUTUBE_DESCRIPTION_MAX = 5000;
const TRUNC_NOTICE = "… [transcript truncated]";
const PREFIX = "The Bloodbag and Painkiller Show: Clan Wars ";

// YouTube rejects `<` and `>` anywhere in a title or description.
const noAngles = (s: string) => s.replace(/[<>]/gu, "");
// Plain text for the description: markdown backticks and bold/italic markers go, names stay (KOTH).
const stripMarkdown = (s: string) => s.replace(/[`*_]/gu, "");

/** Spec §2.4. The series prefix keeps these apart from the KOTH episodes on the same channel. */
export function videoTitle(code: string, subtitle: string): string {
  const head = `${PREFIX}${code} · `;
  return head + noAngles(subtitle).slice(0, YOUTUBE_TITLE_MAX - head.length).trim();
}

export function buildVideoMeta(o: { code: string; subtitle: string; transcript: string }): { title: string; description: string } {
  let description = noAngles(stripMarkdown(o.transcript));
  if (description.length > YOUTUBE_DESCRIPTION_MAX) description = description.slice(0, YOUTUBE_DESCRIPTION_MAX - TRUNC_NOTICE.length) + TRUNC_NOTICE;
  return { title: videoTitle(o.code, o.subtitle), description };
}
```

- [ ] **Step 5: Write `scripts/youtube-auth.ts`**

Port KOTH `scripts/youtube-auth.js` with these changes:
- `SCOPE = "https://www.googleapis.com/auth/youtube"`. `videos.update` and `playlistItems.insert` need the full scope.
- No `dotenv`: run it under the env file, as the runbook shows.
- The output line is `YOUTUBE_REFRESH_TOKEN=<token>`, printed to the operator's own terminal only.
- No em dashes in its messages.

```ts
import readline from "node:readline";

// ⚠️ The full `youtube` scope: videos.update (privacy) and playlistItems.insert need it, and the
// KOTH token's youtube.upload + youtube.readonly cannot do either (spec §9.1).
const SCOPE = "https://www.googleapis.com/auth/youtube";
const REDIRECT = "http://localhost"; // a Desktop OAuth client; the redirect page will not load, so copy the code from the URL

const ask = (q: string) => new Promise<string>((res) => {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  rl.question(q, (a) => { rl.close(); res(a.trim()); });
});

const clientId = process.env.YOUTUBE_CLIENT_ID;
const clientSecret = process.env.YOUTUBE_CLIENT_SECRET;
if (!clientId || !clientSecret) {
  console.error("Set YOUTUBE_CLIENT_ID and YOUTUBE_CLIENT_SECRET first.");
  process.exit(2);
}
const authUrl = "https://accounts.google.com/o/oauth2/v2/auth?" + new URLSearchParams({
  client_id: clientId, redirect_uri: REDIRECT, response_type: "code", scope: SCOPE, access_type: "offline", prompt: "consent",
}).toString();
console.log(`\n1) Open this URL in a browser signed in to the show's YouTube channel:\n\n${authUrl}\n`);
console.log("2) Approve. The browser goes to http://localhost/?code=... and fails to load, which is expected.");
console.log("3) Copy the value of the code parameter from the address bar.\n");
const code = await ask("Paste the authorization code here: ");
const res = await fetch("https://oauth2.googleapis.com/token", {
  method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, code, redirect_uri: REDIRECT, grant_type: "authorization_code" }).toString(),
});
const j = (await res.json().catch(() => null)) as { refresh_token?: string } | null;
if (!res.ok || !j?.refresh_token) {
  console.error(`\nToken exchange failed ${res.status}. If there is no refresh_token, run this again.`);
  process.exit(1);
}
console.log(`\nAdd this line to /opt/clan-wars/.env:\n\nYOUTUBE_REFRESH_TOKEN=${j.refresh_token}\n`);
```

In `apps/show/package.json` `scripts`, add `"youtube-auth": "tsx scripts/youtube-auth.ts"`. If `tsconfig.json`'s `include` does not cover `scripts/`, add it so the script typechecks.

- [ ] **Step 6: Run to verify they pass**

Run: `cd apps/show && npx vitest run test/engine && npx tsc --noEmit -p .`

Expected: PASS. The boundary test also covers the new engine files.

- [ ] **Step 7: Commit**

```bash
git add apps/show/src/engine/publish/youtube apps/show/test/engine/publish apps/show/scripts apps/show/package.json apps/show/tsconfig.json
git commit -m "feat(show): YouTube client with privacy, playlist and find; youtube-auth"
```

---

### Task 6: Facebook: the KOTH port plus find by link, and the caption

**Files:**
- Create: `apps/show/src/engine/publish/facebook/facebook.ts`, `apps/show/src/engine/publish/facebook/buildFacebookCaption.ts`
- Test: `apps/show/test/engine/publish/facebook.test.ts`

**Interfaces:**
- Consumes: KOTH `bot/src/facebook/facebook.js` `uploadPageVideo` at `a5ef8e7`, behavior unchanged. `longLivedPageToken` is not ported: the Page token already exists in the KOTH `.env` and is reused.
- Produces:

```ts
export async function uploadPageVideo(o: { pageId: string; accessToken: string; filePath: string; description: string; fetchImpl?: typeof fetch; fsImpl?: { readFileSync(p: string): Buffer } }): Promise<string>;
export async function findPageVideoByLink(o: { pageId: string; accessToken: string; link: string; fetchImpl?: typeof fetch }): Promise<string | null>;
export function buildFacebookCaption(o: { code: string; subtitle: string; youtubeVideoId: string; discordInvite: string }): string;
```

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, it, expect } from "vitest";
import { uploadPageVideo, findPageVideoByLink } from "../../../src/engine/publish/facebook/facebook.js";
import { buildFacebookCaption } from "../../../src/engine/publish/facebook/buildFacebookCaption.js";

describe("uploadPageVideo (KOTH)", () => {
  it("POSTs multipart to /{page}/videos and returns the id", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchImpl = (async (url: string, init: RequestInit) => { calls.push({ url, init }); return new Response(JSON.stringify({ id: "FB" }), { status: 200 }); }) as unknown as typeof fetch;
    expect(await uploadPageVideo({ pageId: "123", accessToken: "PAT", filePath: "/x.mp4", description: "hello", fetchImpl, fsImpl: { readFileSync: () => Buffer.from("MP4") } })).toBe("FB");
    expect(calls[0]!.url).toBe("https://graph.facebook.com/v21.0/123/videos");
    const form = calls[0]!.init.body as FormData;
    expect(form.get("access_token")).toBe("PAT");
    expect(form.get("description")).toBe("hello");
  });
  it("throws with the Graph error on non-2xx", async () => {
    const fetchImpl = (async () => new Response(JSON.stringify({ error: { message: "bad token" } }), { status: 400 })) as unknown as typeof fetch;
    await expect(uploadPageVideo({ pageId: "1", accessToken: "t", filePath: "/x", description: "d", fetchImpl, fsImpl: { readFileSync: () => Buffer.from("X") } })).rejects.toThrow(/bad token|400/u);
  });
});

describe("findPageVideoByLink", () => {
  it("finds the recent Page video whose description carries the link", async () => {
    let seen = "";
    const fetchImpl = (async (url: string) => { seen = url; return new Response(JSON.stringify({ data: [{ id: "a", description: "x" }, { id: "b", description: "watch https://youtu.be/V1" }] }), { status: 200 }); }) as unknown as typeof fetch;
    expect(await findPageVideoByLink({ pageId: "9", accessToken: "PAT", link: "https://youtu.be/V1", fetchImpl })).toBe("b");
    expect(seen).toBe("https://graph.facebook.com/v21.0/9/videos?fields=id%2Cdescription&limit=10&access_token=PAT");
  });
  it("returns null when none matches", async () => {
    const fetchImpl = (async () => new Response(JSON.stringify({ data: [] }), { status: 200 })) as unknown as typeof fetch;
    expect(await findPageVideoByLink({ pageId: "9", accessToken: "PAT", link: "https://youtu.be/V1", fetchImpl })).toBeNull();
  });
});

describe("buildFacebookCaption", () => {
  const c = buildFacebookCaption({ code: "S01E03", subtitle: "The Curse", youtubeVideoId: "V1", discordInvite: "discord.gg/TJu4XP25nr" });
  it("names the episode, links YouTube and the Discord", () => {
    expect(c).toContain("Clan Wars S01E03 · The Curse");
    expect(c).toContain("https://youtu.be/V1");
    expect(c).toContain("https://discord.gg/TJu4XP25nr");
  });
  it("has no em or en dash and says clan, not faction", () => {
    expect(c).not.toMatch(/[–—]/u);
    expect(c).not.toMatch(/faction/iu);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd apps/show && npx vitest run test/engine/publish/facebook.test.ts`

Expected: FAIL.

- [ ] **Step 3: Implement**

`src/engine/publish/facebook/facebook.ts`: port `uploadPageVideo` (`GRAPH = "https://graph.facebook.com/v21.0"`, multipart `access_token`, `description`, `source` as `episode.mp4`) to TypeScript, then add:

```ts
/** A crash between upload and the row write left this video behind (spec §8.3); the caption carries the YouTube link. */
export async function findPageVideoByLink(o: { pageId: string; accessToken: string; link: string; fetchImpl?: typeof fetch }): Promise<string | null> {
  const q = new URLSearchParams({ fields: "id,description", limit: "10", access_token: o.accessToken });
  const res = await (o.fetchImpl ?? fetch)(`${GRAPH}/${o.pageId}/videos?${q}`);
  const j = (await res.json().catch(() => null)) as { data?: { id: string; description?: string }[] } | null;
  if (!res.ok) throw new Error(`Facebook /videos failed ${res.status}: ${JSON.stringify(j ?? {})}`);
  return j?.data?.find((v) => v.description?.includes(o.link))?.id ?? null;
}
```

`src/engine/publish/facebook/buildFacebookCaption.ts`:

```ts
/** A short cross-promo caption, not the transcript (KOTH). ⚠️ No em dash: the KOTH caption had one. */
export function buildFacebookCaption(o: { code: string; subtitle: string; youtubeVideoId: string; discordInvite: string }): string {
  return [
    `\u{1F399}️ The Bloodbag and Painkiller Show: Clan Wars ${o.code} · ${o.subtitle}`,
    "This week in Clan Wars: the raids, the grudges and the friendly fire.",
    `▶️ Full episode on YouTube: https://youtu.be/${o.youtubeVideoId}`,
    `\u{1F4AC} Join the war: https://${o.discordInvite}`,
  ].join("\n\n");
}
```

- [ ] **Step 4: Run to verify they pass**

Run: `cd apps/show && npx vitest run test/engine && npx tsc --noEmit -p .`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/show/src/engine/publish/facebook apps/show/test/engine/publish/facebook.test.ts
git commit -m "feat(show): Facebook Page upload, find by link, and caption"
```

---

### Task 7: Ops and forum text

**Files:**
- Create: `apps/show/src/stages/text.ts`
- Test: `apps/show/test/stages/text.test.ts`

**Interfaces:**
- Consumes: `formatBanter` (`src/engine/llm/formatBanter.ts`); `episodeCode` (`src/weeks.ts`); `DiscordEmbed`, `OutMessage` (`src/engine/publish/discord.ts`); `Redaction` (`src/screening/redact.ts`).
- Produces:

```ts
export const DRAFT_MARKER_PREFIX = "show:";
export function draftMarker(weekStart: Date): string;                      // "show:2026-09-21"
export function publicText(s: string): string;                             // REDACTED_* -> [REDACTED]
export function forumThreadName(code: string, subtitle: string): string;   // "Clan Wars S01E03 · T", <=100
export function opsSafe(reason: string, blocked: string[]): string;
export function draftMessage(o: { weekStart: Date; code: string; subtitle: string; youtubeVideoId: string; narrative: string; redactions: Redaction[]; scriptAttempts: number }): OutMessage;
export function heldMessage(o: { code: string; weekStart: Date; reasons: string[]; blocked: string[] }): OutMessage;
export function alertMessage(o: { code: string; stage: string; attempts: number; error: string; blocked: string[] }): OutMessage;
export function transcriptMessages(o: { narrative: string; names: string[]; mp3: Buffer }): OutMessage[];
```

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, it, expect } from "vitest";
import { alertMessage, draftMarker, draftMessage, forumThreadName, heldMessage, opsSafe, publicText, transcriptMessages } from "../../src/stages/text.js";

const MON = new Date("2026-09-21T00:00:00Z");
const allText = (m: { content?: string; embeds?: { description: string }[]; files?: { data: Buffer }[] }) =>
  [m.content ?? "", ...(m.embeds ?? []).map((e) => e.description), ...(m.files ?? []).map((f) => f.data.toString("utf8"))].join("\n");

describe("stage text", () => {
  it("marks a draft by week", () => {
    expect(draftMarker(MON)).toBe("show:2026-09-21");
  });

  it("writes redaction aliases as [REDACTED] in anything public", () => {
    expect(publicText("REDACTED_PLAYER_2 hit REDACTED_CLAN_1")).toBe("[REDACTED] hit [REDACTED]");
  });

  it("names the forum thread per spec §2.4 and caps it at 100", () => {
    expect(forumThreadName("S01E03", "The Curse")).toBe("Clan Wars S01E03 · The Curse");
    expect(forumThreadName("S01E03", "x".repeat(200)).length).toBe(100);
  });

  describe("opsSafe", () => {
    const blocked = ["BadName88"];
    it.each([
      ["attempt 1: blocklist: slurword", "attempt 1: blocklist hit"],
      ['attempt 2: blocked text: "BadName88"', "attempt 2: a blocked name came back"],
      ["attempt 1 (trimmed): moderation: says slurword", "attempt 1 (trimmed): moderation flagged it"],
      ["attempt 1: too long: BadName88 said 7000 characters", "attempt 1: too long: [blocked text] said 7000 characters"],
    ])("%s", (raw, safe) => {
      expect(opsSafe(raw, blocked)).toBe(safe);
    });
    it("masks a blocked string in any case", () => {
      expect(opsSafe("error near badname88", blocked)).toBe("error near [blocked text]");
    });
  });

  it("drafts with the link, the marker, counts not names, and the transcript as a file", () => {
    const m = draftMessage({
      weekStart: MON, code: "S01E03", subtitle: "The Curse", youtubeVideoId: "V1",
      narrative: "Boris: REDACTED_PLAYER_1 again.", scriptAttempts: 2,
      redactions: [{ text: "BadName88", kinds: ["gamertag"], replacement: "REDACTED_PLAYER_1", reason: "blocklist: x", source: "blocklist" }],
    });
    expect(m.content).toContain("https://youtu.be/V1");
    expect(m.content).toContain("show:2026-09-21");
    expect(m.content).toContain("1 name redacted");
    expect(m.content).toContain("attempt 2");
    expect(m.content!.length).toBeLessThanOrEqual(2000);
    expect(m.files![0]!.name).toBe("transcript.txt");
    expect(allText(m)).toContain("[REDACTED] again.");
    expect(allText(m)).not.toContain("BadName88");
  });

  it("holds without naming what tripped", () => {
    const m = heldMessage({ code: "S01E03", weekStart: MON, reasons: ['attempt 1: blocked text: "BadName88"', "attempt 2: blocklist: slurword"], blocked: ["BadName88"] });
    expect(m.content).toContain("S01E03");
    expect(m.content).toContain("pnpm run show --week 2026-09-21 --force");
    expect(m.content).not.toContain("BadName88");
    expect(m.content).not.toContain("slurword");
  });

  it("alerts with the stage, count and a masked, capped error", () => {
    const m = alertMessage({ code: "S01E03", stage: "uploaded", attempts: 3, error: `BadName88 ${"e".repeat(1000)}`, blocked: ["BadName88"] });
    expect(m.content).toContain("uploaded");
    expect(m.content).toContain("3");
    expect(m.content).not.toContain("BadName88");
    expect(m.content!.length).toBeLessThanOrEqual(2000);
  });

  it("splits the transcript into embeds of at most 4,096 and messages of at most 6,000, mp3 on the first", () => {
    const line = "Boris: GoldSkull588 raided again and again and again.\n";
    const narrative = line.repeat(250); // ~13,500 characters before formatting
    const ms = transcriptMessages({ narrative, names: ["GoldSkull588"], mp3: Buffer.from("MP3") });
    expect(ms.length).toBeGreaterThan(1);
    for (const m of ms) {
      const total = (m.embeds ?? []).reduce((n, e) => n + e.description.length, 0);
      expect(total).toBeLessThanOrEqual(6000);
      for (const e of m.embeds ?? []) expect(e.description.length).toBeLessThanOrEqual(4096);
    }
    expect(ms[0]!.files![0]).toMatchObject({ name: "episode.mp3", contentType: "audio/mpeg" });
    expect(ms.slice(1).every((m) => !m.files)).toBe(true);
    expect(ms[0]!.embeds![0]!.description).toContain("**BORIS**");
    expect(ms[0]!.embeds![0]!.description).toContain("`GoldSkull588`");
  });

  it("keeps every public string free of em and en dashes", () => {
    const ms = transcriptMessages({ narrative: "Boris: a — b – c", names: [], mp3: Buffer.from("") });
    expect(allText(ms[0]!)).not.toMatch(/[–—]/u);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd apps/show && npx vitest run test/stages/text.test.ts`

Expected: FAIL.

- [ ] **Step 3: Implement `src/stages/text.ts`**

```ts
import { formatBanter } from "../engine/llm/formatBanter.js";
import type { DiscordEmbed, OutMessage } from "../engine/publish/discord.js";
import type { Redaction } from "../screening/redact.js";
import { escapeRe } from "../screening/redact.js";

export const DRAFT_MARKER_PREFIX = "show:";
const EMBED_MAX = 4096;
const MESSAGE_EMBED_TOTAL = 6000;
const CONTENT_MAX = 2000;

const day = (d: Date) => d.toISOString().slice(0, 10);
export const draftMarker = (weekStart: Date) => `${DRAFT_MARKER_PREFIX}${day(weekStart)}`;

/** Spec §7.3: a redacted name is drawn as `[REDACTED]`; the same goes for every published string. */
export const publicText = (s: string) => s.replace(/REDACTED_(?:PLAYER|CLAN)_\d+/gu, "[REDACTED]");
// ⚠️ Player-facing copy carries no em or en dash (standing rule); the model's are normalized in parse, this is the net.
const noDashes = (s: string) => s.replace(/\s*[–—]\s*/gu, ", ");

export const forumThreadName = (code: string, subtitle: string) => `Clan Wars ${code} · ${publicText(subtitle)}`.slice(0, 100);

/**
 * ⚠️ The ops channel is a Discord channel, not the operator's terminal: a held reason or an
 * error must not carry a blocked gamertag, a blocklist term or a moderator's quote of one.
 * Reasons are reduced to their category; anything else has each blocked string masked.
 */
export function opsSafe(reason: string, blocked: string[]): string {
  const m = /^(attempt \d+(?: \(trimmed\))?): (.*)$/su.exec(reason);
  const [prefix, body] = m ? [`${m[1]}: `, m[2]!] : ["", reason];
  if (body.startsWith("blocklist:")) return `${prefix}blocklist hit`;
  if (body.startsWith("blocked text:")) return `${prefix}a blocked name came back`;
  if (body.startsWith("moderation:")) return `${prefix}moderation flagged it`;
  const masked = [...blocked].sort((a, b) => b.length - a.length)
    .reduce((acc, b) => acc.replace(new RegExp(escapeRe(b), "giu"), "[blocked text]"), body);
  return prefix + masked;
}

function redactionSummary(rs: Redaction[]): string {
  if (rs.length === 0) return "Screening: nothing redacted.";
  const names = rs.filter((r) => r.replacement !== null).length;
  const dropped = rs.length - names;
  const parts = [names ? `${names} name${names === 1 ? "" : "s"} redacted` : "", dropped ? `${dropped} pitch or bounty reason dropped` : ""].filter(Boolean);
  return `Screening: ${parts.join(", ")}. See \`pnpm show:screening --show <week>\` on the host.`;
}

export function draftMessage(o: { weekStart: Date; code: string; subtitle: string; youtubeVideoId: string; narrative: string; redactions: Redaction[]; scriptAttempts: number }): OutMessage {
  const content = [
    `**Clan Wars ${o.code} · ${publicText(o.subtitle)}** is ready for review (unlisted): https://youtu.be/${o.youtubeVideoId}`,
    "React ✅ to publish or ❌ to reject. Only approvers count.",
    redactionSummary(o.redactions),
    `Script passed on attempt ${o.scriptAttempts}.`,
    `-# ${draftMarker(o.weekStart)}`,
  ].join("\n");
  return {
    content: content.slice(0, CONTENT_MAX),
    files: [{ name: "transcript.txt", data: Buffer.from(noDashes(publicText(o.narrative)), "utf8"), contentType: "text/plain; charset=utf-8" }],
  };
}

export function heldMessage(o: { code: string; weekStart: Date; reasons: string[]; blocked: string[] }): OutMessage {
  const lines = [
    `⚠️ Clan Wars ${o.code} is held: the script failed screening twice.`,
    ...o.reasons.map((r) => `- ${opsSafe(r, o.blocked)}`),
    `Change the overrides with \`pnpm show:screening\`, then run \`pnpm run show --week ${day(o.weekStart)} --force\`.`,
  ];
  return { content: lines.join("\n").slice(0, CONTENT_MAX) };
}

export function alertMessage(o: { code: string; stage: string; attempts: number; error: string; blocked: string[] }): OutMessage {
  const err = opsSafe(o.error, o.blocked).slice(0, 1500);
  return { content: `⚠️ Clan Wars ${o.code} has failed ${o.attempts} times at stage "${o.stage}". Timer runs keep retrying.\n\`\`\`\n${err}\n\`\`\``.slice(0, CONTENT_MAX) };
}

/** Line-boundary chunks of at most `max` characters (a single longer line is hard-split). */
function chunk(text: string, max: number): string[] {
  const out: string[] = [];
  let cur = "";
  for (const line of text.split("\n")) {
    for (let piece = line; ; ) {
      const add = cur ? `${cur}\n${piece}` : piece;
      if (add.length <= max) { cur = add; break; }
      if (cur) { out.push(cur); cur = ""; continue; }
      out.push(piece.slice(0, max));
      piece = piece.slice(max);
      if (!piece) break;
    }
  }
  if (cur) out.push(cur);
  return out;
}

/**
 * The forum transcript (spec §9.3): `formatBanter` (hosts bold caps, names in backticks), in
 * embeds of at most 4,096 characters packed into messages of at most 6,000, the mp3 attached
 * to the first message.
 */
export function transcriptMessages(o: { narrative: string; names: string[]; mp3: Buffer }): OutMessage[] {
  const text = formatBanter(noDashes(publicText(o.narrative)), o.names);
  const embeds: DiscordEmbed[] = chunk(text, EMBED_MAX).map((description) => ({ description }));
  const messages: OutMessage[] = [];
  let cur: DiscordEmbed[] = [];
  let total = 0;
  for (const e of embeds) {
    if (cur.length === 10 || total + e.description.length > MESSAGE_EMBED_TOTAL) { messages.push({ embeds: cur }); cur = []; total = 0; }
    cur.push(e);
    total += e.description.length;
  }
  if (cur.length) messages.push({ embeds: cur });
  if (messages.length === 0) messages.push({ content: "(no transcript)" });
  messages[0] = { ...messages[0], files: [{ name: "episode.mp3", data: o.mp3, contentType: "audio/mpeg" }] };
  return messages;
}
```

- [ ] **Step 4: Run to verify they pass**

Run: `cd apps/show && npx vitest run test/stages/text.test.ts && npx tsc --noEmit -p .`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/show/src/stages/text.ts apps/show/test/stages/text.test.ts
git commit -m "feat(show): ops draft, held note, alert and forum transcript text"
```

---

### Task 8: The stage runner and the production stages (new → rendered, held)

**Files:**
- Create: `apps/show/src/stages/run.ts`
- Test: `apps/show/test/stages/run.test.ts`, `apps/show/test/stages/deps.ts` (fakes)

**Interfaces:**
- Consumes: the store (Task 3), text (Task 7), `buildStoryContext`, `redactContext`, `Verdict`, `ScriptResult`, `VoicedEpisode`, `collectNames`, `episodeCode`.
- Produces (Task 9 adds the publish steps to the same file):

```ts
export type YouTubeOps = {
  findUpload(title: string): Promise<string | null>;
  upload(o: { filePath: string; title: string; description: string }): Promise<string>; // always unlisted
  ensureInPlaylist(videoId: string): Promise<void>;
  setPublic(videoId: string): Promise<void>;
  waitProcessed(videoId: string): Promise<boolean>;
};
export type FacebookOps = { find(link: string): Promise<string | null>; upload(o: { filePath: string; description: string }): Promise<string> };
export type StageDeps = {
  db: Database;
  now: () => Date;
  staffTags: string[];
  screen: (texts: string[]) => Promise<Map<string, Verdict>>;
  writeScript: (ctx: StoryContext, blocked: string[], allowed: string[]) => Promise<ScriptResult>;
  voice: (ep: { weekStart: string; narrative: string; context: StoryContext }) => Promise<VoicedEpisode>;
  render: (ep: { voiced: VoicedEpisode; context: StoryContext }) => Promise<string>;
  readFile: (p: string) => Buffer;
  youtube: YouTubeOps;
  discord: Discord;
  facebook: FacebookOps | null;
  cfg: { guildId: string; opsChannelId: string | null; forumChannelId: string; requireApproval: boolean; approverIds: string[]; discordInvite: string };
  log: (line: string) => void;
};
export type StoredReport = { redactions: Redaction[]; blocked: string[]; allowed: string[]; scriptReasons?: string[]; scriptAttempts?: number };
export type RunOutcome = "done" | "waiting" | "terminal" | "failed";
export const ALERT_AT_ATTEMPTS = 3;
export async function runStages(deps: StageDeps, weekStart: Date): Promise<{ outcome: RunOutcome; row: EpisodeRow }>;
```

How it works:
- `stage` names the last finished stage. `nextStage(row, cfg)` maps it to the step to run: `new→context→scripted→voiced→rendered→uploaded→(awaiting_approval | approved)→approved→public→posted→done`.
- `uploaded` goes to `awaiting_approval` when approval is on, else straight to `approved` (spec §8.2).
- Each step either returns the advanced row or returns `"wait"`.
- A thrown error is recorded with `recordFailure`. Exactly at 3 attempts, one alert is posted to ops, best-effort. Then the run stops with `failed`.

- [ ] **Step 1: Write the fakes `test/stages/deps.ts`**

```ts
import type { Database } from "@factions/db";
import type { StageDeps } from "../../src/stages/run.js";
import type { Discord, OutMessage } from "../../src/engine/publish/discord.js";
import type { Verdict } from "../../src/screening/store.js";

export type Posted = { channelId: string; msg: OutMessage; id: string };

/** Every external effect recorded, nothing real. Override any field per test. */
export function fakeDeps(db: Database, over: Partial<StageDeps> = {}) {
  const posted: Posted[] = [];
  const reactions = new Map<string, string[]>(); // `${messageId}:${emoji}` -> user ids
  const threads: { id: string; forumId: string; name: string; first: OutMessage }[] = [];
  const uploads: { id: string; title: string }[] = [];
  const playlist = new Set<string>();
  const publicIds = new Set<string>();
  const fbVideos: { id: string; description: string }[] = [];
  const calls = { voice: 0, render: 0, script: 0 };
  let n = 0;
  const discord: Discord = {
    me: async () => "BOT",
    post: async (channelId, msg) => { const id = `m${++n}`; posted.push({ channelId, msg, id }); return { id }; },
    react: async (_c, m, e) => { reactions.set(`${m}:${e}`, [...(reactions.get(`${m}:${e}`) ?? []), "BOT"]); },
    reactionUserIds: async (_c, m, e) => reactions.get(`${m}:${e}`) ?? [],
    recentMessages: async (channelId) => posted.filter((p) => p.channelId === channelId).map((p) => ({ id: p.id, content: p.msg.content ?? "", authorId: "BOT", embeds: p.msg.embeds?.length ?? 0, attachments: p.msg.files?.length ?? 0 })),
    createForumThread: async (forumId, name, first) => { const id = `t${++n}`; threads.push({ id, forumId, name, first }); posted.push({ channelId: id, msg: first, id }); return { threadId: id }; },
    findForumThread: async (_g, forumId, name) => threads.find((t) => t.forumId === forumId && t.name === name)?.id ?? null,
  };
  const deps: StageDeps = {
    db,
    now: () => new Date("2026-09-28T07:00:00Z"),
    staffTags: ["ADM"],
    screen: async (texts) => new Map(texts.map((t) => [t, { verdict: "allow", source: "llm", reason: null } satisfies Verdict])),
    writeScript: async () => { calls.script++; return { ok: true, narrative: "Boris: Hello.\nPavel: Hi.", title: "The Curse", storylines: [], attempts: 1, reasons: [] }; },
    voice: async (ep) => { calls.voice++; return { key: `k-${ep.weekStart}`, mp3Path: "/cache/k/episode.mp3", totalSec: 10, segASpan: { startSec: 1, durSec: 8 }, outroSpan: { startSec: 9, durSec: 1 }, timeline: [] }; },
    render: async () => { calls.render++; return "/cache/k/video.mp4"; },
    readFile: () => Buffer.from("BYTES"),
    youtube: {
      findUpload: async (title) => uploads.find((u) => u.title === title)?.id ?? null,
      upload: async ({ title }) => { const id = `yt${++n}`; uploads.push({ id, title }); return id; },
      ensureInPlaylist: async (id) => { playlist.add(id); },
      setPublic: async (id) => { publicIds.add(id); },
      waitProcessed: async () => true,
    },
    discord,
    facebook: {
      find: async (link) => fbVideos.find((v) => v.description.includes(link))?.id ?? null,
      upload: async ({ description }) => { const id = `fb${++n}`; fbVideos.push({ id, description }); return id; },
    },
    cfg: { guildId: "G", opsChannelId: "OPS", forumChannelId: "FORUM", requireApproval: true, approverIds: ["ADMIN1"], discordInvite: "discord.gg/TJu4XP25nr" },
    log: () => {},
    ...over,
  };
  return { deps, posted, reactions, threads, uploads, playlist, publicIds, fbVideos, calls };
}
```

- [ ] **Step 2: Write the failing production-stage tests `test/stages/run.test.ts`**

```ts
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import type { Database } from "@factions/db";
import { openDb, makeFixture, MON, type Fx } from "../fixture.js";
import { runStages } from "../../src/stages/run.js";
import { advance, createEpisode, getEpisode, setFields } from "../../src/stages/store.js";
import { fakeDeps } from "./deps.js";

describe("runStages: production", () => {
  let db: Database; let fx: Fx;
  beforeAll(async () => { db = await openDb(); });
  beforeEach(async () => { fx = await makeFixture(db); });

  it("walks a new week through to the approval wait, persisting context, screening and script", async () => {
    const f = fakeDeps(db);
    const { outcome, row } = await runStages(f.deps, MON);
    expect(outcome).toBe("waiting");
    expect(row.stage).toBe("awaiting_approval");
    expect(row).toMatchObject({ narrative: "Boris: Hello.\nPavel: Hi.", title: "The Curse", seasonNumber: 1, episodeNumber: 3 });
    expect(row.context).toMatchObject({ week: { season: 1, episode: 3 } });
    expect(row.screeningReport).toMatchObject({ redactions: [], blocked: [], allowed: [], scriptReasons: [], scriptAttempts: 1 });
    expect(f.calls).toMatchObject({ script: 1, render: 1 });
  });

  it("persists the blocked list at the context stage and hands it to the script stage", async () => {
    const sna = await fx.clan({ tag: "SNA" });
    await fx.player("p", "BadName88");
    await fx.member(sna, "p");
    await fx.kill({ at: new Date(MON.getTime() + 3_600_000), killer: "p", victim: "v", killerClan: sna });
    let seenBlocked: string[] = [];
    const f = fakeDeps(db, {
      screen: async (texts) => new Map(texts.map((t) => [t, t === "BadName88" ? { verdict: "block", source: "blocklist", reason: "blocklist: x" } : { verdict: "allow", source: "llm", reason: null }] as const)),
      writeScript: async (_c, blocked) => { seenBlocked = blocked; return { ok: false, reasons: ['attempt 1: blocked text: "BadName88"'], attempts: 2 }; },
    });
    const { outcome, row } = await runStages(f.deps, MON);
    expect(seenBlocked).toEqual(["BadName88"]);
    expect(outcome).toBe("terminal");
    expect(row.stage).toBe("held");
    expect(row.screeningReport).toMatchObject({ blocked: ["BadName88"], scriptReasons: ['attempt 1: blocked text: "BadName88"'] });
    expect(JSON.stringify(row.context)).not.toContain("BadName88");
    const note = f.posted.find((p) => p.channelId === "OPS")!;
    expect(note.msg.content).toContain("held");
    expect(note.msg.content).not.toContain("BadName88");
  });

  it("passes operator-allowed texts to the script stage", async () => {
    await fx.player("p", "Nazgul");
    await fx.kill({ at: new Date(MON.getTime() + 3_600_000), killer: "p", victim: "v" });
    let seenAllowed: string[] = [];
    const f = fakeDeps(db, {
      screen: async (texts) => new Map(texts.map((t) => [t, { verdict: "allow", source: t === "Nazgul" ? "operator" : "llm", reason: null }] as const)),
      writeScript: async (_c, _b, allowed) => { seenAllowed = allowed; return { ok: true, narrative: "Boris: x", title: "T", storylines: [], attempts: 1, reasons: [] }; },
    });
    await runStages(f.deps, MON);
    expect(seenAllowed).toEqual(["Nazgul"]);
  });

  it("never rewrites a stored narrative: resuming at scripted voices the stored one", async () => {
    await runStages(fakeDeps(db, { writeScript: async () => { throw new Error("stop"); } }).deps, MON); // leaves stage=context with a real context
    await advance(db, MON, "scripted", { narrative: "Boris: Stored.", title: "Stored", storylines: [], screeningReport: { redactions: [], blocked: [], allowed: [], scriptReasons: [], scriptAttempts: 1 } });
    const seen: string[] = [];
    const f = fakeDeps(db, { voice: async (ep) => { seen.push(ep.narrative); return { key: "k", mp3Path: "/m", totalSec: 1, segASpan: { startSec: 0, durSec: 1 }, outroSpan: { startSec: 1, durSec: 0 }, timeline: [] }; } });
    await runStages(f.deps, MON);
    expect(f.calls.script).toBe(0);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((n) => n === "Boris: Stored.")).toBe(true);
  });

  it("records a failure, alerts once at the third attempt, and not again at the fourth", async () => {
    const f = fakeDeps(db, { render: async () => { throw new Error("ffmpeg died"); } });
    for (let i = 1; i <= 4; i++) {
      const { outcome, row } = await runStages(f.deps, MON);
      expect(outcome).toBe("failed");
      expect(row).toMatchObject({ stage: "voiced", attempts: i, lastError: "ffmpeg died" });
    }
    const alerts = f.posted.filter((p) => p.channelId === "OPS" && p.msg.content?.includes("has failed"));
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.msg.content).toContain('"rendered"');
  });

  it("resumes at the stage after the failed one and resets the count", async () => {
    let fail = true;
    const f = fakeDeps(db, { render: async () => { if (fail) throw new Error("x"); return "/v.mp4"; } });
    await runStages(f.deps, MON);
    fail = false;
    const { row } = await runStages(f.deps, MON);
    expect(row).toMatchObject({ stage: "awaiting_approval", attempts: 0, lastError: null });
  });

  it("an alert that cannot be posted does not mask the stage failure", async () => {
    const f = fakeDeps(db, { render: async () => { throw new Error("x"); } });
    f.deps.discord.post = async () => { throw new Error("discord down"); };
    for (let i = 0; i < 3; i++) await runStages(f.deps, MON);
    expect((await getEpisode(db, MON))!.attempts).toBe(3);
  });
});
```


- [ ] **Step 3: Run to verify they fail**

Run: `cd apps/show && TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions" npx vitest run test/stages/run.test.ts`

Expected: FAIL, `run.js` is missing.

- [ ] **Step 4: Implement `src/stages/run.ts` (the production half and the loop)**

```ts
import type { Database } from "@factions/db";
import type { ShowStage } from "@factions/domain";
import type { Discord } from "../engine/publish/discord.js";
import type { VoicedEpisode } from "../produce/voice.js";
import type { ScriptResult } from "../script/write-script.js";
import { redactContext, type Redaction } from "../screening/redact.js";
import type { Verdict } from "../screening/store.js";
import { buildStoryContext } from "../story/context.js";
import type { StoryContext } from "../story/types.js";
import { episodeCode } from "../weeks.js";
import { advance, createEpisode, getEpisode, recordFailure, TERMINAL_STAGES, type EpisodeRow } from "./store.js";
import { alertMessage, heldMessage } from "./text.js";

export type YouTubeOps = {
  findUpload(title: string): Promise<string | null>;
  upload(o: { filePath: string; title: string; description: string }): Promise<string>;
  ensureInPlaylist(videoId: string): Promise<void>;
  setPublic(videoId: string): Promise<void>;
  waitProcessed(videoId: string): Promise<boolean>;
};
export type FacebookOps = { find(link: string): Promise<string | null>; upload(o: { filePath: string; description: string }): Promise<string> };
export type StageDeps = {
  db: Database;
  now: () => Date;
  staffTags: string[];
  screen: (texts: string[]) => Promise<Map<string, Verdict>>;
  writeScript: (ctx: StoryContext, blocked: string[], allowed: string[]) => Promise<ScriptResult>;
  voice: (ep: { weekStart: string; narrative: string; context: StoryContext }) => Promise<VoicedEpisode>;
  render: (ep: { voiced: VoicedEpisode; context: StoryContext }) => Promise<string>;
  readFile: (p: string) => Buffer;
  youtube: YouTubeOps;
  discord: Discord;
  facebook: FacebookOps | null;
  cfg: { guildId: string; opsChannelId: string | null; forumChannelId: string; requireApproval: boolean; approverIds: string[]; discordInvite: string };
  log: (line: string) => void;
};
export type StoredReport = { redactions: Redaction[]; blocked: string[]; allowed: string[]; scriptReasons?: string[]; scriptAttempts?: number };
export type RunOutcome = "done" | "waiting" | "terminal" | "failed";
export const ALERT_AT_ATTEMPTS = 3;

type Step = (deps: StageDeps, row: EpisodeRow) => Promise<EpisodeRow | "wait">;

const ctxOf = (row: EpisodeRow) => row.context as StoryContext;
const reportOf = (row: EpisodeRow) => (row.screeningReport ?? { redactions: [], blocked: [], allowed: [] }) as StoredReport;
export const codeOf = (row: EpisodeRow) => episodeCode(row.seasonNumber, row.episodeNumber);
const voiceIn = (row: EpisodeRow) => ({ weekStart: row.weekStart.toISOString(), narrative: row.narrative!, context: ctxOf(row) });

/** Best-effort: an ops note that cannot be posted is logged, never a stage failure. */
export async function notifyOps(deps: StageDeps, msg: Parameters<Discord["post"]>[1]): Promise<void> {
  if (!deps.cfg.opsChannelId) { deps.log(`ops (no OPS_CHANNEL_ID): ${msg.content ?? ""}`); return; }
  try { await deps.discord.post(deps.cfg.opsChannelId, msg); } catch (e) { deps.log(`ops post failed: ${(e as Error).message}`); }
}

const context: Step = async (deps, row) => {
  const { context: raw, texts } = await buildStoryContext(deps.db, { weekStart: row.weekStart, staffTags: deps.staffTags, previous: "db" });
  // ⚠️ Fails closed: a screen that throws fails the stage; nothing unscreened is ever stored.
  const verdicts = await deps.screen(texts.entries().map((e) => e.text));
  const allowed = [...verdicts].filter(([, v]) => v.verdict === "allow" && v.source === "operator").map(([t]) => t);
  const { context: screened, report, blocked } = redactContext(raw, texts.entries(), verdicts);
  // The blocked list is persisted here: the script stage may run in a later process (plan 2 parked item).
  const stored: StoredReport = { redactions: report.redactions, blocked, allowed };
  return advance(deps.db, row.weekStart, "context", { context: screened, screeningReport: stored });
};

const scripted: Step = async (deps, row) => {
  const rep = reportOf(row);
  const result = await deps.writeScript(ctxOf(row), rep.blocked, rep.allowed);
  if (!result.ok) {
    const held = await advance(deps.db, row.weekStart, "held", { screeningReport: { ...rep, scriptReasons: result.reasons, scriptAttempts: result.attempts } });
    await notifyOps(deps, heldMessage({ code: codeOf(row), weekStart: row.weekStart, reasons: result.reasons, blocked: rep.blocked }));
    return held;
  }
  return advance(deps.db, row.weekStart, "scripted", {
    narrative: result.narrative, title: result.title, storylines: result.storylines,
    screeningReport: { ...rep, scriptReasons: result.reasons, scriptAttempts: result.attempts },
  });
};

const voiced: Step = async (deps, row) => {
  await deps.voice(voiceIn(row));
  return advance(deps.db, row.weekStart, "voiced");
};

const rendered: Step = async (deps, row) => {
  // A cache hit: the voiced stage's files are reused, no TTS is paid twice.
  const v = await deps.voice(voiceIn(row));
  await deps.render({ voiced: v, context: ctxOf(row) });
  return advance(deps.db, row.weekStart, "rendered");
};

// Task 9 fills these in.
const PUBLISH_STEPS: Partial<Record<ShowStage, Step>> = {};

const STEPS: Partial<Record<ShowStage, Step>> = { context, scripted, voiced, rendered };

export function nextStage(row: EpisodeRow, cfg: StageDeps["cfg"]): ShowStage | null {
  switch (row.stage) {
    case "new": return "context";
    case "context": return "scripted";
    case "scripted": return "voiced";
    case "voiced": return "rendered";
    case "rendered": return "uploaded";
    case "uploaded": return cfg.requireApproval ? "awaiting_approval" : "approved";
    case "awaiting_approval": return "approved";
    case "approved": return "public";
    case "public": return "posted";
    case "posted": return "done";
    default: return null;
  }
}

/** Run from the row's stage until a step waits, fails, or the row is terminal (spec §8.1 step 4). */
export async function runStages(deps: StageDeps, weekStart: Date): Promise<{ outcome: RunOutcome; row: EpisodeRow }> {
  let row = (await getEpisode(deps.db, weekStart)) ?? (await createEpisode(deps.db, weekStart));
  for (;;) {
    if (row.stage === "done") return { outcome: "done", row };
    if (TERMINAL_STAGES.includes(row.stage)) return { outcome: "terminal", row };
    const next = nextStage(row, deps.cfg)!;
    const step = STEPS[next] ?? PUBLISH_STEPS[next];
    if (!step) throw new Error(`no step for stage ${next}`);
    try {
      const r = await step(deps, row);
      if (r === "wait") return { outcome: "waiting", row };
      deps.log(`${codeOf(row)}: ${row.stage} -> ${r.stage}`);
      row = r;
    } catch (e) {
      const msg = (e as Error).message ?? String(e);
      const attempts = await recordFailure(deps.db, weekStart, msg);
      deps.log(`${codeOf(row)}: stage "${next}" failed (attempt ${attempts}): ${msg}`);
      // ⚠️ Exactly at 3, so the alert is not repeated by every later timer run (spec §8.3).
      if (attempts === ALERT_AT_ATTEMPTS) {
        await notifyOps(deps, alertMessage({ code: codeOf(row), stage: next, attempts, error: msg, blocked: reportOf(row).blocked }));
      }
      return { outcome: "failed", row: (await getEpisode(deps.db, weekStart))! };
    }
  }
}
```

`PUBLISH_STEPS` is empty in this task, so a run stops with a failure at `uploaded`. Move the `if (!step) throw` inside the `try`, so that throw is recorded like any stage failure. For this task only:
- Write the first test (`walks a new week ... approval wait`) as `it.todo`. Add an interim test asserting `outcome: "failed"`, `row.stage: "rendered"` and `lastError` matching `/no step for stage uploaded/u`.
- The "resumes" test asserts `stage: "rendered"`.

Task 9 replaces the interim test with the full one and moves "resumes" to `awaiting_approval`.

- [ ] **Step 5: Run to verify they pass**

Run: `cd apps/show && TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions" npx vitest run test/stages && npx tsc --noEmit -p .`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/show/src/stages/run.ts apps/show/test/stages
git commit -m "feat(show): stage runner with context, script, voice and render stages"
```

---

### Task 9: The publishing stages (uploaded → done, approval, idempotency)

**Files:**
- Modify: `apps/show/src/stages/run.ts`
- Test: `apps/show/test/stages/run.test.ts` (restore the full first test; add `describe("runStages: publishing")`)

**Interfaces:**
- Consumes: `videoTitle`, `buildVideoMeta` (Task 5); `buildFacebookCaption` (Task 6); `draftMarker`, `draftMessage`, `forumThreadName`, `publicText`, `transcriptMessages` (Task 7); `setFields` (Task 3); `collectNames` (`src/produce/names.ts`).
- Produces: `PUBLISH_STEPS` filled for `uploaded`, `awaiting_approval`, `approved`, `public`, `posted` and `done`. Exported constants `APPROVE = "✅"` and `REJECT = "❌"`.

Behavior, per step:
- **uploaded:**
  - Use `row.youtubeVideoId`, else `youtube.findUpload(title)`, else `youtube.upload(...)`. The title is `videoTitle(code, publicText(title))`; the description comes from `buildVideoMeta` over `publicText(narrative)`; the file is `render(...)` (a cache hit).
  - `setFields` the id right after, then `ensureInPlaylist`, then advance.
- **awaiting_approval:**
  - Use `row.draftMessageId`, else a recent ops message by the bot whose content contains `draftMarker(week)`, else post `draftMessage` and react ✅ then ❌.
  - Advance with `draftMessageId`.
  - If `opsChannelId` is null, throw (config forbids this while approval is on).
- **approved:**
  - Approval off: advance with no approver.
  - Approval on: read ✅ and ❌ users. If any approver reacted ❌, advance to `rejected` with that id and time. Else if any approver reacted ✅, advance to `approved` with that id and time. Else `"wait"`.
  - The bot's own reactions and non-approvers are ignored.
- **public:** `youtube.setPublic(id)`, then advance with `youtubePublicAt`. `setPublic` is idempotent on YouTube's side.
- **posted:**
  - If `!waitProcessed(id)`, throw `not processed yet`.
  - Thread: `row.forumThreadId`, else `findForumThread(guildId, forumId, name)`, else `createForumThread(forumId, name, { content: "https://youtu.be/<id>" })`. Then `setFields` the thread id.
  - If the bot has fewer than 2 messages in the thread, post every `transcriptMessages` message; the mp3 bytes come from `readFile(voice(...).mp3Path)`.
  - Advance with `discordPostedAt`.
- **done:**
  - If `facebook` is null, advance.
  - Else use `row.facebookVideoId ?? find(link) ?? upload(...)` and advance with the id and time.
  - On any Facebook error, advance to `done` with `lastError: "facebook: <message>"` and do not throw (spec §8.3).

- [ ] **Step 1: Write the failing tests**

Replace the interim first test with the full one from Task 8's Step 2. Update the "resumes" test to `awaiting_approval`. Add:

```ts
describe("runStages: publishing", () => {
  let db: Database;
  beforeAll(async () => { db = await openDb(); });
  beforeEach(async () => { await makeFixture(db); });

  const draftOf = (f: ReturnType<typeof fakeDeps>) => f.posted.find((p) => p.channelId === "OPS" && p.msg.content?.includes("ready for review"))!;

  it("uploads unlisted with the spec title, adds to the playlist and drafts once", async () => {
    const f = fakeDeps(db);
    await runStages(f.deps, MON);
    expect(f.uploads).toEqual([{ id: expect.any(String), title: "The Bloodbag and Painkiller Show: Clan Wars S01E03 · The Curse" }]);
    expect(f.playlist.has(f.uploads[0]!.id)).toBe(true);
    expect(f.publicIds.size).toBe(0);
    const d = draftOf(f);
    expect(d.msg.content).toContain("show:2026-09-21");
    expect(f.reactions.get(`${d.id}:✅`)).toEqual(["BOT"]);
    await runStages(f.deps, MON); // a second run with no reactions only waits
    expect(f.posted.filter((p) => p.msg.content?.includes("ready for review"))).toHaveLength(1);
  });

  it("an approver's ✅ publishes: public, forum thread with the link, transcript with mp3, Facebook, done", async () => {
    const f = fakeDeps(db);
    await runStages(f.deps, MON);
    const d = draftOf(f);
    f.reactions.set(`${d.id}:✅`, ["BOT", "ADMIN1"]);
    const { outcome, row } = await runStages(f.deps, MON);
    expect(outcome).toBe("done");
    expect(row).toMatchObject({ stage: "done", approvedByDiscordId: "ADMIN1", forumThreadId: f.threads[0]!.id, facebookVideoId: f.fbVideos[0]!.id });
    expect(row.youtubePublicAt).not.toBeNull();
    expect(f.publicIds.has(row.youtubeVideoId!)).toBe(true);
    expect(f.threads[0]).toMatchObject({ forumId: "FORUM", name: "Clan Wars S01E03 · The Curse", first: { content: `https://youtu.be/${row.youtubeVideoId}` } });
    const inThread = f.posted.filter((p) => p.channelId === f.threads[0]!.id);
    expect(inThread).toHaveLength(2);
    expect(inThread[1]!.msg.files![0]!.name).toBe("episode.mp3");
    expect(f.fbVideos[0]!.description).toContain(`https://youtu.be/${row.youtubeVideoId}`);
  });

  it("ignores ✅ from a non-approver and from the bot", async () => {
    const f = fakeDeps(db);
    await runStages(f.deps, MON);
    f.reactions.set(`${draftOf(f).id}:✅`, ["BOT", "RANDOM"]);
    expect((await runStages(f.deps, MON)).row.stage).toBe("awaiting_approval");
  });

  it("an approver's ❌ rejects, and beats a ✅; the video stays unlisted", async () => {
    const f = fakeDeps(db);
    await runStages(f.deps, MON);
    const d = draftOf(f);
    f.reactions.set(`${d.id}:✅`, ["ADMIN1"]);
    f.reactions.set(`${d.id}:❌`, ["ADMIN1"]);
    const { outcome, row } = await runStages(f.deps, MON);
    expect(outcome).toBe("terminal");
    expect(row).toMatchObject({ stage: "rejected", rejectedByDiscordId: "ADMIN1", youtubePublicAt: null });
    expect(f.publicIds.size).toBe(0);
  });

  it("with approval off goes from upload straight to public and posted", async () => {
    const f = fakeDeps(db);
    f.deps.cfg = { ...f.deps.cfg, requireApproval: false };
    const { row } = await runStages(f.deps, MON);
    expect(row.stage).toBe("done");
    expect(row.draftMessageId).toBeNull();
    expect(f.posted.some((p) => p.msg.content?.includes("ready for review"))).toBe(false);
  });

  it("crash window: an upload with no row write is adopted, not repeated", async () => {
    const f = fakeDeps(db);
    f.uploads.push({ id: "ytORPHAN", title: "The Bloodbag and Painkiller Show: Clan Wars S01E03 · The Curse" });
    const { row } = await runStages(f.deps, MON);
    expect(row.youtubeVideoId).toBe("ytORPHAN");
    expect(f.uploads).toHaveLength(1);
  });

  it("crash window: a draft with no row write is adopted by its marker", async () => {
    const f = fakeDeps(db);
    await f.deps.discord.post("OPS", { content: "**Clan Wars S01E03** is ready for review\n-# show:2026-09-21" });
    const { row } = await runStages(f.deps, MON);
    expect(row.draftMessageId).toBe("m1");
    expect(f.posted.filter((p) => p.msg.content?.includes("ready for review"))).toHaveLength(1);
  });

  it("crash window: a forum thread and transcript already posted are not posted again", async () => {
    const f = fakeDeps(db);
    f.deps.cfg = { ...f.deps.cfg, requireApproval: false };
    f.deps.facebook = null;
    let crash = true;
    const realAdvance = f.deps.discord.post;
    f.deps.discord.post = async (c, m) => { const r = await realAdvance(c, m); if (crash && m.files?.[0]?.name === "episode.mp3") { crash = false; throw new Error("crashed after posting"); } return r; };
    await runStages(f.deps, MON); // posts thread + transcript, then "crashes"
    const { row } = await runStages(f.deps, MON);
    expect(row.stage).toBe("done");
    expect(f.threads).toHaveLength(1);
    expect(f.posted.filter((p) => p.channelId === f.threads[0]!.id)).toHaveLength(2);
  });

  it("crash window: a Facebook video with no row write is adopted by its link", async () => {
    const f = fakeDeps(db);
    f.deps.cfg = { ...f.deps.cfg, requireApproval: false };
    await runStages({ ...f.deps, facebook: null }, MON).catch(() => {});
    await setFields(db, MON, { stage: "posted" as never });
    const row0 = (await getEpisode(db, MON))!;
    f.fbVideos.push({ id: "fbORPHAN", description: `watch https://youtu.be/${row0.youtubeVideoId}` });
    const { row } = await runStages(f.deps, MON);
    expect(row.facebookVideoId).toBe("fbORPHAN");
  });

  it("a Facebook failure is logged in the row and does not hold the episode", async () => {
    const f = fakeDeps(db);
    f.deps.cfg = { ...f.deps.cfg, requireApproval: false };
    f.deps.facebook = { find: async () => null, upload: async () => { throw new Error("token expired"); } };
    const { outcome, row } = await runStages(f.deps, MON);
    expect(outcome).toBe("done");
    expect(row).toMatchObject({ stage: "done", facebookVideoId: null, lastError: "facebook: token expired" });
  });

  it("waits for YouTube processing by failing the posted stage, then posts on a later run", async () => {
    const f = fakeDeps(db);
    f.deps.cfg = { ...f.deps.cfg, requireApproval: false };
    let processed = false;
    f.deps.youtube.waitProcessed = async () => processed;
    const first = await runStages(f.deps, MON);
    expect(first).toMatchObject({ outcome: "failed", row: { stage: "public", lastError: "YouTube has not finished processing the video yet" } });
    processed = true;
    expect((await runStages(f.deps, MON)).row.stage).toBe("done");
  });
});
```

The Facebook crash-window test drives the row to `posted` without Facebook, then plants the orphan. Implement it as written. If `setFields` with `stage` feels wrong, use `advance(db, MON, "posted")`, which is equivalent here.

- [ ] **Step 2: Run to verify they fail**

Run: `cd apps/show && TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions" npx vitest run test/stages/run.test.ts`

Expected: FAIL at `no step for stage uploaded`.

- [ ] **Step 3: Implement the steps in `src/stages/run.ts`**

Add the imports:

```ts
import { buildFacebookCaption } from "../engine/publish/facebook/buildFacebookCaption.js";
import { buildVideoMeta, videoTitle } from "../engine/publish/youtube/buildVideoMeta.js";
import { collectNames } from "../produce/names.js";
import { setFields } from "./store.js";
import { draftMarker, draftMessage, forumThreadName, publicText, transcriptMessages } from "./text.js";
```

Replace `const PUBLISH_STEPS: Partial<Record<ShowStage, Step>> = {};` with:

```ts
export const APPROVE = "✅";
export const REJECT = "❌";
const watchUrl = (id: string) => `https://youtu.be/${id}`;

const uploaded: Step = async (deps, row) => {
  const title = videoTitle(codeOf(row), publicText(row.title!));
  // ⚠️ Post first, row second (spec §8.3); an upload a crash left unrecorded is found by its exact title.
  let id = row.youtubeVideoId ?? (await deps.youtube.findUpload(title));
  if (!id) {
    const filePath = await deps.render({ voiced: await deps.voice(voiceIn(row)), context: ctxOf(row) });
    const meta = buildVideoMeta({ code: codeOf(row), subtitle: publicText(row.title!), transcript: publicText(row.narrative!) });
    id = await deps.youtube.upload({ filePath, title: meta.title, description: meta.description });
  }
  if (row.youtubeVideoId !== id) await setFields(deps.db, row.weekStart, { youtubeVideoId: id });
  await deps.youtube.ensureInPlaylist(id);
  return advance(deps.db, row.weekStart, "uploaded", { youtubeVideoId: id });
};

const awaitingApproval: Step = async (deps, row) => {
  const ops = deps.cfg.opsChannelId;
  if (!ops) throw new Error("approval is on but OPS_CHANNEL_ID is unset");
  let id = row.draftMessageId;
  if (!id) {
    const me = await deps.discord.me();
    const marker = draftMarker(row.weekStart);
    id = (await deps.discord.recentMessages(ops, 50)).find((m) => m.authorId === me && m.content.includes(marker))?.id ?? null;
  }
  if (!id) {
    const rep = reportOf(row);
    const posted = await deps.discord.post(ops, draftMessage({
      weekStart: row.weekStart, code: codeOf(row), subtitle: row.title!, youtubeVideoId: row.youtubeVideoId!,
      narrative: row.narrative!, redactions: rep.redactions, scriptAttempts: rep.scriptAttempts ?? 1,
    }));
    id = posted.id;
    await setFields(deps.db, row.weekStart, { draftMessageId: id });
    // Convenience only: the approver clicks rather than hunts for the emoji. Not counted (the bot is no approver).
    try { await deps.discord.react(ops, id, APPROVE); await deps.discord.react(ops, id, REJECT); } catch (e) { deps.log(`draft reactions: ${(e as Error).message}`); }
  }
  return advance(deps.db, row.weekStart, "awaiting_approval", { draftMessageId: id });
};

const approved: Step = async (deps, row) => {
  if (!deps.cfg.requireApproval) return advance(deps.db, row.weekStart, "approved");
  const ops = deps.cfg.opsChannelId!;
  const approvers = new Set(deps.cfg.approverIds);
  const by = async (emoji: string) => (await deps.discord.reactionUserIds(ops, row.draftMessageId!, emoji)).find((u) => approvers.has(u)) ?? null;
  // ⚠️ ❌ is read first and wins: when two approvers disagree, nothing goes public.
  const rejecter = await by(REJECT);
  if (rejecter) return advance(deps.db, row.weekStart, "rejected", { rejectedByDiscordId: rejecter, rejectedAt: deps.now() });
  const approver = await by(APPROVE);
  if (approver) return advance(deps.db, row.weekStart, "approved", { approvedByDiscordId: approver, approvedAt: deps.now() });
  return "wait";
};

const makePublic: Step = async (deps, row) => {
  await deps.youtube.setPublic(row.youtubeVideoId!);
  return advance(deps.db, row.weekStart, "public", { youtubePublicAt: deps.now() });
};

const posted: Step = async (deps, row) => {
  const vid = row.youtubeVideoId!;
  // Spec §9.1: a thread posted before processing embeds a "processing" card forever.
  if (!(await deps.youtube.waitProcessed(vid))) throw new Error("YouTube has not finished processing the video yet");
  const name = forumThreadName(codeOf(row), row.title!);
  let thread = row.forumThreadId ?? (await deps.discord.findForumThread(deps.cfg.guildId, deps.cfg.forumChannelId, name));
  if (!thread) thread = (await deps.discord.createForumThread(deps.cfg.forumChannelId, name, { content: watchUrl(vid) })).threadId;
  if (row.forumThreadId !== thread) await setFields(deps.db, row.weekStart, { forumThreadId: thread });
  const me = await deps.discord.me();
  const mine = (await deps.discord.recentMessages(thread, 20)).filter((m) => m.authorId === me);
  // The first message is the link; anything after it means the transcript already went out.
  if (mine.length < 2) {
    const v = await deps.voice(voiceIn(row));
    for (const msg of transcriptMessages({ narrative: row.narrative!, names: collectNames(ctxOf(row)).names, mp3: deps.readFile(v.mp3Path) })) {
      await deps.discord.post(thread, msg);
    }
  }
  return advance(deps.db, row.weekStart, "posted", { forumThreadId: thread, discordPostedAt: deps.now() });
};

const done: Step = async (deps, row) => {
  if (!deps.facebook) return advance(deps.db, row.weekStart, "done");
  const link = watchUrl(row.youtubeVideoId!);
  try {
    let id = row.facebookVideoId ?? (await deps.facebook.find(link));
    if (!id) {
      const filePath = await deps.render({ voiced: await deps.voice(voiceIn(row)), context: ctxOf(row) });
      id = await deps.facebook.upload({ filePath, description: buildFacebookCaption({ code: codeOf(row), subtitle: publicText(row.title!), youtubeVideoId: row.youtubeVideoId!, discordInvite: deps.cfg.discordInvite }) });
    }
    return advance(deps.db, row.weekStart, "done", { facebookVideoId: id, facebookPostedAt: deps.now() });
  } catch (e) {
    // Spec §8.3: best-effort, as in the KOTH show. Logged in the row, never holds the episode.
    return advance(deps.db, row.weekStart, "done", { lastError: `facebook: ${(e as Error).message}` });
  }
};

const PUBLISH_STEPS: Partial<Record<ShowStage, Step>> = {
  uploaded, awaiting_approval: awaitingApproval, approved, public: makePublic, posted, done,
};
```

The crash-window thread test depends on a detail. The throw after the transcript post happens before `advance`, so the second run finds the thread by `row.forumThreadId` (already set) and sees 2 bot messages. Do not move the `setFields` for the thread after the transcript post.

- [ ] **Step 4: Run to verify they pass**

Run: `cd apps/show && TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions" npx vitest run test/stages && npx tsc --noEmit -p .`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/show/src/stages/run.ts apps/show/test/stages/run.test.ts
git commit -m "feat(show): publishing stages with approval and crash-safe posts"
```

---

### Task 10: The service entry and CLI dispatch

**Files:**
- Create: `apps/show/src/dry-run.ts`, `apps/show/src/service.ts`
- Rewrite: `apps/show/src/cli.ts`
- Modify: `apps/show/package.json` (`"start": "tsx src/cli.ts"`)
- Test: `apps/show/test/service.test.ts`

**Interfaces:**
- Consumes: `loadServiceConfig`, `SHOW_LOCK_KEY` (Task 2); `pickWeek`, `forceWeek` (Task 3); `runStages`, `StageDeps` (Tasks 8 and 9); the engine clients (Tasks 4 to 6); `acquireAdvisoryLock`, `createClient` (`@factions/db`); and the existing `voiceEpisode`, `renderEpisode`, `screenTexts`, `createModerator`, `PgScreeningStore`, `PgPronunciationStore`, `writeScript`, `createChat`.
- Produces:

```ts
// dry-run.ts: the current cli.ts body, as a function, behavior unchanged
export async function runDryRun(opts: { week?: string; printPrompt: boolean; render?: string }): Promise<number>; // exit code
// service.ts
export type ServiceArgs = { week?: Date; force: boolean; repost: boolean };
export async function serviceMain(args: ServiceArgs, env?: NodeJS.ProcessEnv, io?: ServiceIo): Promise<number>;
export type ServiceIo = {
  lock: (url: string, key: number) => Promise<{ release(): Promise<void> } | null>;
  openDb: (url: string) => Database;
  buildDeps: (db: Database, cfg: Extract<ServiceConfig, { enabled: true }>) => StageDeps;
  now: () => Date;
  log: (s: string) => void;
};
export function realDeps(db: Database, cfg: Extract<ServiceConfig, { enabled: true }>): StageDeps;
```

Exit codes:
- `0`: nothing to do, lock held elsewhere, disabled, waiting, done or terminal.
- `1`: a stage failed, so the unit shows failed and the journal has the line.
- `2`: usage error, `--force` refused, or `--repost` without `--force`.

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { sql } from "drizzle-orm";
import type { Database } from "@factions/db";
import { openDb, makeFixture, MON, at, URL } from "./fixture.js";
import { serviceMain, type ServiceIo } from "../src/service.js";
import { getEpisode, advance, createEpisode } from "../src/stages/store.js";
import { fakeDeps } from "./stages/deps.js";

const ENV = {
  DATABASE_URL: URL, OPENROUTER_API_KEY: "k", SHOW_ENABLED: "1",
  ELEVENLABS_API_KEY: "e", ELEVENLABS_BORIS_VOICE_ID: "b", ELEVENLABS_PAVEL_VOICE_ID: "p",
  DISCORD_TOKEN: "t", DISCORD_GUILD_ID: "111111111111111111", OPS_CHANNEL_ID: "222222222222222222",
  SHOW_FORUM_CHANNEL_ID: "333333333333333333", SHOW_APPROVER_DISCORD_IDS: "444444444444444444",
  YOUTUBE_CLIENT_ID: "a", YOUTUBE_CLIENT_SECRET: "b", YOUTUBE_REFRESH_TOKEN: "c", YOUTUBE_PLAYLIST_ID: "d",
};

describe("serviceMain", () => {
  let db: Database;
  beforeAll(async () => { db = await openDb(); });
  beforeEach(async () => { await makeFixture(db); });

  const io = (over: Partial<ServiceIo> = {}): ServiceIo & { lines: string[] } => {
    const lines: string[] = [];
    return {
      lines,
      lock: async () => ({ release: async () => {} }),
      openDb: () => db,
      buildDeps: (d) => fakeDeps(d).deps,
      now: () => at(7, 7),
      log: (s) => lines.push(s),
      ...over,
    };
  };

  it("exits 0 without touching anything when another run holds the lock", async () => {
    const i = io({ lock: async () => null });
    expect(await serviceMain({ force: false, repost: false }, ENV, i)).toBe(0);
    expect(i.lines.join("\n")).toMatch(/another show run/u);
  });

  it("exits 0 when SHOW_ENABLED is off", async () => {
    const i = io();
    expect(await serviceMain({ force: false, repost: false }, { DATABASE_URL: URL }, i)).toBe(0);
    expect(i.lines.join("\n")).toMatch(/SHOW_ENABLED/u);
  });

  it("does nothing when no week is ready", async () => {
    const i = io();
    expect(await serviceMain({ force: false, repost: false }, ENV, i)).toBe(0);
    expect(await getEpisode(db, MON)).toBeNull();
  });

  it("runs the picked week to the approval wait", async () => {
    await db.execute(sql`update seasons set week_closed_through = ${MON.toISOString()}::timestamptz`);
    expect(await serviceMain({ force: false, repost: false }, ENV, io())).toBe(0);
    expect((await getEpisode(db, MON))!.stage).toBe("awaiting_approval");
  });

  it("--week runs that week even when the picker would not", async () => {
    expect(await serviceMain({ week: MON, force: false, repost: false }, ENV, io())).toBe(0);
    expect((await getEpisode(db, MON))!.stage).toBe("awaiting_approval");
  });

  it("exits 1 when a stage fails", async () => {
    const i = io({ buildDeps: (d) => fakeDeps(d, { render: async () => { throw new Error("x"); } }).deps });
    expect(await serviceMain({ week: MON, force: false, repost: false }, ENV, i)).toBe(1);
  });

  it("--force refuses a public episode without --repost, exit 2, row unchanged", async () => {
    await createEpisode(db, MON);
    await advance(db, MON, "posted", { narrative: "Boris: x", youtubePublicAt: new Date() });
    expect(await serviceMain({ week: MON, force: true, repost: false }, ENV, io())).toBe(2);
    expect((await getEpisode(db, MON))!.stage).toBe("posted");
  });

  it("--force without --week or --repost without --force is a usage error", async () => {
    expect(await serviceMain({ force: true, repost: false }, ENV, io())).toBe(2);
    expect(await serviceMain({ week: MON, force: false, repost: true }, ENV, io())).toBe(2);
  });

  it("--force resets a held week and runs it again", async () => {
    await createEpisode(db, MON);
    await advance(db, MON, "held", { screeningReport: { blocked: [] } });
    expect(await serviceMain({ week: MON, force: true, repost: false }, ENV, io())).toBe(0);
    expect((await getEpisode(db, MON))!.stage).toBe("awaiting_approval");
  });

  it("releases the lock even when the run throws", async () => {
    let released = false;
    const i = io({ lock: async () => ({ release: async () => { released = true; } }), buildDeps: () => { throw new Error("wiring"); } });
    await expect(serviceMain({ week: MON, force: false, repost: false }, ENV, i)).rejects.toThrow(/wiring/u);
    expect(released).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd apps/show && TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions" npx vitest run test/service.test.ts`

Expected: FAIL.

- [ ] **Step 3: Move the dry run out of `cli.ts`**

Create `src/dry-run.ts`:
- Move the whole of today's `cli.ts` body below `parseArgs` into `export async function runDryRun(opts)`.
- `values.week` → `opts.week`, `values["print-prompt"]` → `opts.printPrompt`, `values.render` → `opts.render`.
- Return `1` where it set `process.exitCode = 1`, otherwise `0`.
- Keep the read-only client, the probe, and every comment.
- Delete the "Neither --dry-run nor --render" guard: dispatch now happens in `cli.ts`.

- [ ] **Step 4: Implement `src/service.ts`**

```ts
import fs from "node:fs";
import { acquireAdvisoryLock, createClient, type Database } from "@factions/db";
import { loadServiceConfig, SHOW_LOCK_KEY, type ServiceConfig } from "./config.js";
import { createChat } from "./engine/llm/openrouter.js";
import { createDiscord } from "./engine/publish/discord.js";
import { findPageVideoByLink, uploadPageVideo } from "./engine/publish/facebook/facebook.js";
import { accessTokenFromRefresh, addToPlaylist, findUploadByTitle, playlistHas, setPrivacy, uploadVideo, waitForVideoProcessed } from "./engine/publish/youtube/youtube.js";
import { spawnRun, type Run } from "./engine/run.js";
import { renderEpisode } from "./produce/render.js";
import { voiceEpisode } from "./produce/voice.js";
import { createModerator } from "./screening/moderate.js";
import { screenTexts } from "./screening/screen.js";
import { PgScreeningStore } from "./screening/store.js";
import { writeScript } from "./script/write-script.js";
import { forceWeek } from "./stages/store.js";
import { pickWeek } from "./stages/pick.js";
import { runStages, type StageDeps } from "./stages/run.js";
import { PgPronunciationStore } from "./stores/pronunciations.js";

type On = Extract<ServiceConfig, { enabled: true }>;
export type ServiceArgs = { week?: Date; force: boolean; repost: boolean };
export type ServiceIo = {
  lock: (url: string, key: number) => Promise<{ release(): Promise<void> } | null>;
  openDb: (url: string) => Database;
  buildDeps: (db: Database, cfg: On) => StageDeps;
  now: () => Date;
  log: (s: string) => void;
};

/** The real wiring: every external effect the stages make, from config. */
export function realDeps(db: Database, cfg: On): StageDeps {
  const chat = createChat({ apiKey: cfg.base.openrouterApiKey });
  const moderate = createModerator({ chat, model: cfg.base.moderationModel });
  const screeningStore = new PgScreeningStore(db);
  const runImpl: Run = (cmd, args, opts) => spawnRun(cmd === "ffmpeg" ? cfg.render.ffmpegPath : cmd, args, opts);
  const yt = cfg.youtube;
  // A fresh access token per call: a render-then-upload run outlives the one-hour token.
  const token = () => accessTokenFromRefresh({ clientId: yt.clientId, clientSecret: yt.clientSecret, refreshToken: yt.refreshToken });
  const fb = cfg.facebook;
  return {
    db,
    now: () => new Date(),
    staffTags: cfg.base.staffTags,
    screen: (texts) => screenTexts(texts, { store: screeningStore, moderate }),
    writeScript: (ctx, blocked, allowed) => writeScript(ctx, blocked, {
      generate: (system, user) => chat({ model: cfg.base.scriptModel, temperature: 0.9, messages: [{ role: "system", content: system }, { role: "user", content: user }] }),
      moderate, allowed,
    }),
    voice: (ep) => voiceEpisode({
      chat, pronunciationModel: cfg.render.pronunciationModel, store: new PgPronunciationStore(db), overrides: cfg.render.pronunciationOverrides,
      elevenApiKey: cfg.render.elevenApiKey, elevenModel: cfg.render.elevenModel, borisVoiceId: cfg.render.borisVoiceId, pavelVoiceId: cfg.render.pavelVoiceId,
      cacheDir: cfg.render.cacheDir, rhubarbPath: cfg.render.rhubarbPath, runImpl,
    }, ep),
    render: (ep) => renderEpisode({ cacheDir: cfg.render.cacheDir, discordInvite: cfg.render.discordInvite, runImpl }, ep),
    readFile: (p) => fs.readFileSync(p),
    youtube: {
      findUpload: async (title) => findUploadByTitle({ accessToken: await token(), title }),
      upload: async ({ filePath, title, description }) => uploadVideo({ accessToken: await token(), filePath, title, description, privacy: "unlisted" }),
      ensureInPlaylist: async (videoId) => {
        const accessToken = await token();
        if (!(await playlistHas({ accessToken, playlistId: yt.playlistId, videoId }))) await addToPlaylist({ accessToken, playlistId: yt.playlistId, videoId });
      },
      setPublic: async (videoId) => setPrivacy({ accessToken: await token(), videoId, privacy: "public" }),
      waitProcessed: async (videoId) => waitForVideoProcessed({ accessToken: await token(), videoId }),
    },
    discord: createDiscord({ token: cfg.discordToken }),
    facebook: fb ? {
      find: (link) => findPageVideoByLink({ pageId: fb.pageId, accessToken: fb.accessToken, link }),
      upload: ({ filePath, description }) => uploadPageVideo({ pageId: fb.pageId, accessToken: fb.accessToken, filePath, description }),
    } : null,
    cfg: {
      guildId: cfg.guildId, opsChannelId: cfg.opsChannelId, forumChannelId: cfg.forumChannelId,
      requireApproval: cfg.requireApproval, approverIds: cfg.approverIds, discordInvite: cfg.render.discordInvite,
    },
    log: (s) => console.log(s),
  };
}

const REAL_IO: ServiceIo = {
  lock: acquireAdvisoryLock,
  openDb: (url) => createClient(url),
  buildDeps: realDeps,
  now: () => new Date(),
  log: (s) => console.log(s),
};

/** One run, exactly what the timer does (spec §8.1, §10). Returns the process exit code. */
export async function serviceMain(args: ServiceArgs, env: NodeJS.ProcessEnv = process.env, io: ServiceIo = REAL_IO): Promise<number> {
  if (args.force && !args.week) { io.log("--force needs --week <date>"); return 2; }
  if (args.repost && !args.force) { io.log("--repost only goes with --force"); return 2; }
  const cfg = loadServiceConfig(env);
  // ⚠️ The same lock for timer and manual runs, so the two can never overlap (spec §2.5).
  const lock = await io.lock(cfg.databaseUrl, SHOW_LOCK_KEY);
  if (!lock) { io.log("another show run holds the lock; exiting"); return 0; }
  const db = io.openDb(cfg.databaseUrl);
  try {
    if (!cfg.enabled) { io.log("SHOW_ENABLED is off; nothing to do"); return 0; }
    if (args.force) {
      const r = await forceWeek(db, args.week!, { repost: args.repost });
      if (r === "public-needs-repost") { io.log("that episode is already public; add --repost to publish a new cut"); return 2; }
      io.log(r === "missing" ? "no row for that week yet; running it fresh" : "reset to new");
    }
    const week = args.week ?? (await pickWeek(db, io.now()));
    if (!week) { io.log("no week is ready"); return 0; }
    const { outcome, row } = await runStages(io.buildDeps(db, cfg), week);
    io.log(`${row.weekStart.toISOString().slice(0, 10)}: ${outcome} at ${row.stage}`);
    return outcome === "failed" ? 1 : 0;
  } finally {
    await lock.release();
    // Only close a client this function opened; the tests pass their own and keep it open.
    if (io === REAL_IO) await db.$client.end();
  }
}
```

- [ ] **Step 5: Rewrite `src/cli.ts`**

```ts
import { parseArgs } from "node:util";
import { runDryRun } from "./dry-run.js";
import { serviceMain } from "./service.js";
import { parseWeekArg } from "./weeks.js";

// `pnpm run show` is one timer run; `--dry-run` and `--render <dir>` are the read-only
// review paths (spec §10). ⚠️ `pnpm run show`, never `pnpm show`: the latter is pnpm's
// own `view` command.
const { values } = parseArgs({
  options: {
    week: { type: "string" },
    "dry-run": { type: "boolean", default: false },
    "print-prompt": { type: "boolean", default: false },
    render: { type: "string" },
    force: { type: "boolean", default: false },
    repost: { type: "boolean", default: false },
  },
});

if (values["dry-run"] || values.render) {
  process.exitCode = await runDryRun({ week: values.week, printPrompt: values["print-prompt"], render: values.render });
} else {
  process.exitCode = await serviceMain({ week: values.week ? parseWeekArg(values.week) : undefined, force: values.force, repost: values.repost });
}
```

In `apps/show/package.json`, add `"start": "tsx src/cli.ts"` beside the existing `"cli"` script.

- [ ] **Step 6: Run to verify they pass**

Run: `cd apps/show && TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions" npx vitest run && npx tsc --noEmit -p .`

Expected: the whole app suite passes.

Then check that the dry run still behaves:

```bash
cd apps/show && DATABASE_URL=postgres://x OPENROUTER_API_KEY=k npx tsx src/cli.ts --week 2026-09-21 --dry-run 2>&1 | head -3
```

Expected: a connection error to `postgres://x`, not an argument error.

- [ ] **Step 7: Commit**

```bash
git add apps/show/src/cli.ts apps/show/src/dry-run.ts apps/show/src/service.ts apps/show/package.json apps/show/test/service.test.ts
git commit -m "feat(show): the scheduled run with lock, force and repost"
```

---

### Task 11: Operator commands (screening overrides, pronunciation backfill)

**Files:**
- Create: `apps/show/src/ops/screening-cli.ts`, `apps/show/src/ops/backfill.ts`, `apps/show/src/ops/backfill-cli.ts`
- Modify: `apps/show/package.json`, root `package.json`
- Test: `apps/show/test/ops/backfill.test.ts`, `apps/show/test/ops/screening.test.ts`

**Interfaces:**
- Consumes: `PgScreeningStore`, `screenTexts`, `resolveCachedPronouncer`, `PgPronunciationStore`, `getEpisode`, `StoredReport`.
- Produces:

```ts
// backfill.ts
export const BACKFILL_CHUNK = 50;
export async function knownNames(db: Database): Promise<string[]>; // every gamertag, clan name and tag, distinct, sorted
export async function backfillPronunciations(o: {
  names: string[]; screen: (t: string[]) => Promise<Map<string, Verdict>>; store: PronunciationStore;
  overrides: Record<string, string>; pronounce: (names: string[]) => Promise<void>; dryRun: boolean;
}): Promise<{ total: number; blocked: number; overridden: number; cached: number; toGenerate: string[]; generated: number }>;
// screening-cli.ts exports for tests
export async function setVerdict(db: Database, text: string, verdict: "allow" | "block"): Promise<void>;
export async function weekReport(db: Database, weekStart: Date): Promise<string>;
```

- [ ] **Step 1: Write the failing tests**

`test/ops/backfill.test.ts`:

```ts
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import type { Database } from "@factions/db";
import { openDb, makeFixture, type Fx } from "../fixture.js";
import { backfillPronunciations, knownNames } from "../../src/ops/backfill.js";
import { MemoryPronunciationStore } from "../../src/engine/audio/pronunciationStore.js";

describe("pronunciation backfill", () => {
  let db: Database; let fx: Fx;
  beforeAll(async () => { db = await openDb(); });
  beforeEach(async () => { fx = await makeFixture(db); });

  it("knows every gamertag, clan name and tag once", async () => {
    await fx.clan({ tag: "SNA", name: "Snakes" });
    await fx.player("a", "GoldSkull588");
    await fx.player("b", "SNA");
    expect(await knownNames(db)).toEqual(["GoldSkull588", "SNA", "Snakes"]);
  });

  it("never sends a blocked name to the pronouncer, skips overrides and cached rows", async () => {
    const store = new MemoryPronunciationStore();
    await store.insertMissing([{ text: "Cached1", spoken: "cached one", source: "llm" }]);
    const asked: string[][] = [];
    const r = await backfillPronunciations({
      names: ["Bad88", "Cached1", "Over", "New1", "New2"],
      screen: async (t) => new Map(t.map((x) => [x, { verdict: x === "Bad88" ? "block" : "allow", source: "llm", reason: null }] as const)),
      store, overrides: { Over: "oh ver" }, dryRun: false,
      pronounce: async (names) => { asked.push(names); await store.insertMissing(names.map((n) => ({ text: n, spoken: n.toLowerCase(), source: "llm" }))); },
    });
    expect(asked).toEqual([["New1", "New2"]]);
    expect(r).toMatchObject({ total: 5, blocked: 1, overridden: 1, cached: 1, toGenerate: ["New1", "New2"], generated: 2 });
  });

  it("dry run screens and counts but pronounces nothing", async () => {
    const store = new MemoryPronunciationStore();
    let called = false;
    const r = await backfillPronunciations({
      names: ["New1"], screen: async (t) => new Map(t.map((x) => [x, { verdict: "allow", source: "llm", reason: null }] as const)),
      store, overrides: {}, dryRun: true, pronounce: async () => { called = true; },
    });
    expect(called).toBe(false);
    expect(r).toMatchObject({ toGenerate: ["New1"], generated: 0 });
  });

  it("chunks the screen and the pronouncer at 50", async () => {
    const names = Array.from({ length: 120 }, (_, i) => `P${i}`);
    const screened: number[] = [];
    const asked: number[] = [];
    const store = new MemoryPronunciationStore();
    await backfillPronunciations({
      names, store, overrides: {}, dryRun: false,
      screen: async (t) => { screened.push(t.length); return new Map(t.map((x) => [x, { verdict: "allow", source: "llm", reason: null }] as const)); },
      pronounce: async (n) => { asked.push(n.length); },
    });
    expect(screened).toEqual([50, 50, 20]);
    expect(asked).toEqual([50, 50, 20]);
  });
});
```

`test/ops/screening.test.ts`:

```ts
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import type { Database } from "@factions/db";
import { openDb, makeFixture, MON } from "../fixture.js";
import { setVerdict, weekReport } from "../../src/ops/screening-cli.js";
import { PgScreeningStore } from "../../src/screening/store.js";
import { advance, createEpisode } from "../../src/stages/store.js";

describe("screening operator commands", () => {
  let db: Database;
  beforeAll(async () => { db = await openDb(); });
  beforeEach(async () => { await makeFixture(db); });

  it("writes an operator verdict that the automatic screens cannot overwrite", async () => {
    await setVerdict(db, "Nazgul", "allow");
    const store = new PgScreeningStore(db);
    await store.put("Nazgul", { verdict: "block", source: "llm", reason: "x" });
    expect((await store.get(["Nazgul"])).get("Nazgul")).toMatchObject({ verdict: "allow", source: "operator" });
  });

  it("an operator can change their own verdict", async () => {
    await setVerdict(db, "Nazgul", "allow");
    await setVerdict(db, "Nazgul", "block");
    expect((await new PgScreeningStore(db).get(["Nazgul"])).get("Nazgul")).toMatchObject({ verdict: "block", source: "operator" });
  });

  it("prints a week's redactions and script reasons raw, for the terminal only", async () => {
    await createEpisode(db, MON);
    await advance(db, MON, "held", { screeningReport: { redactions: [{ text: "Bad88", kinds: ["gamertag"], replacement: "REDACTED_PLAYER_1", reason: "blocklist: 88", source: "blocklist" }], blocked: ["Bad88"], allowed: [], scriptReasons: ['attempt 1: blocked text: "Bad88"'] } });
    const out = await weekReport(db, MON);
    expect(out).toContain("Bad88 -> REDACTED_PLAYER_1 (blocklist: blocklist: 88)");
    expect(out).toContain('attempt 1: blocked text: "Bad88"');
    expect(out).toContain("stage: held");
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd apps/show && TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions" npx vitest run test/ops`

Expected: FAIL.

- [ ] **Step 3: Implement `src/ops/backfill.ts`**

```ts
import { sql } from "drizzle-orm";
import type { Database } from "@factions/db";
import type { PronunciationStore } from "../engine/audio/pronunciationStore.js";
import type { Verdict } from "../screening/store.js";
import { rows } from "../story/sql.js";

export const BACKFILL_CHUNK = 50;

export async function knownNames(db: Database): Promise<string[]> {
  const rs = await rows<{ t: string }>(db, sql`
    select gamertag as t from players union select name from factions union select tag from factions order by 1`);
  return rs.map((r) => r.t).filter((t) => t.trim() !== "");
}

const chunks = <T>(xs: T[], n: number) => Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, i * n + n));

/**
 * `pnpm show:backfill-pronunciations` (spec §10): freeze a spoken form for every known name
 * before an episode needs it. ⚠️ Screened first, in chunks: spec §7.3 never sends a blocked
 * name to the pronunciation pass, and a backfill must not be the way one gets there.
 */
export async function backfillPronunciations(o: {
  names: string[]; screen: (t: string[]) => Promise<Map<string, Verdict>>; store: PronunciationStore;
  overrides: Record<string, string>; pronounce: (names: string[]) => Promise<void>; dryRun: boolean;
}) {
  const names = [...new Set(o.names)];
  const allowed: string[] = [];
  for (const c of chunks(names, BACKFILL_CHUNK)) {
    const v = await o.screen(c);
    for (const t of c) if (v.get(t)?.verdict === "allow") allowed.push(t);
  }
  const overridden = allowed.filter((t) => t in o.overrides);
  const cachedMap = await o.store.get(allowed);
  const cached = allowed.filter((t) => !(t in o.overrides) && t in cachedMap);
  const toGenerate = allowed.filter((t) => !(t in o.overrides) && !(t in cachedMap));
  let generated = 0;
  if (!o.dryRun) {
    for (const c of chunks(toGenerate, BACKFILL_CHUNK)) await o.pronounce(c);
    generated = Object.keys(await o.store.get(toGenerate)).length;
  }
  return { total: names.length, blocked: names.length - allowed.length, overridden: overridden.length, cached: cached.length, toGenerate, generated };
}
```

- [ ] **Step 4: Implement `src/ops/backfill-cli.ts`**

```ts
import { parseArgs } from "node:util";
import { createClient } from "@factions/db";
import { loadConfig, loadRenderConfig } from "../config.js";
import { resolveCachedPronouncer } from "../engine/audio/pronounceCached.js";
import { createChat } from "../engine/llm/openrouter.js";
import { createModerator } from "../screening/moderate.js";
import { screenTexts } from "../screening/screen.js";
import { PgScreeningStore } from "../screening/store.js";
import { PgPronunciationStore } from "../stores/pronunciations.js";
import { backfillPronunciations, knownNames } from "./backfill.js";

const { values } = parseArgs({ options: { "dry-run": { type: "boolean", default: false } } });
const cfg = loadConfig();
const render = loadRenderConfig();
const db = createClient(cfg.databaseUrl);
try {
  const chat = createChat({ apiKey: cfg.openrouterApiKey });
  const moderate = createModerator({ chat, model: cfg.moderationModel });
  const screeningStore = new PgScreeningStore(db);
  const store = new PgPronunciationStore(db);
  const r = await backfillPronunciations({
    names: await knownNames(db), store, overrides: render.pronunciationOverrides, dryRun: values["dry-run"],
    screen: (t) => screenTexts(t, { store: screeningStore, moderate }),
    pronounce: async (names) => { await resolveCachedPronouncer({ store, names, overrides: render.pronunciationOverrides, chat, model: render.pronunciationModel }); },
  });
  console.log(`${values["dry-run"] ? "[dry-run] " : ""}names: ${r.total}, blocked: ${r.blocked}, overridden: ${r.overridden}, cached: ${r.cached}, to generate: ${r.toGenerate.length}, generated: ${r.generated}`);
  if (!values["dry-run"] && r.generated < r.toGenerate.length) console.warn(`${r.toGenerate.length - r.generated} were not generated (LLM failure?); run it again`);
} finally {
  await db.$client.end();
}
```

(The screening pass writes verdicts to `show_text_screening`. That is intended: the same verdicts the show would reach.)

- [ ] **Step 5: Implement `src/ops/screening-cli.ts`**

```ts
import { parseArgs } from "node:util";
import { createClient, type Database } from "@factions/db";
import { PgScreeningStore } from "../screening/store.js";
import type { StoredReport } from "../stages/run.js";
import { getEpisode } from "../stages/store.js";
import { parseWeekArg } from "../weeks.js";

/** Spec §7.4: an operator row wins over both automatic passes and is never overwritten by them. */
export async function setVerdict(db: Database, text: string, verdict: "allow" | "block"): Promise<void> {
  await new PgScreeningStore(db).put(text, { verdict, source: "operator", reason: "operator" });
}

/** ⚠️ Raw blocked text, for the operator's terminal. Never post this to Discord. */
export async function weekReport(db: Database, weekStart: Date): Promise<string> {
  const row = await getEpisode(db, weekStart);
  if (!row) return "no episode row for that week";
  const rep = (row.screeningReport ?? { redactions: [], blocked: [], allowed: [] }) as StoredReport;
  return [
    `stage: ${row.stage}${row.lastError ? ` (last error: ${row.lastError})` : ""}`,
    "redactions:",
    ...(rep.redactions.length ? rep.redactions.map((r) => `  ${r.text} -> ${r.replacement ?? "(dropped)"} (${r.source}: ${r.reason ?? ""})`) : ["  none"]),
    "script:",
    ...((rep.scriptReasons ?? []).length ? rep.scriptReasons!.map((s) => `  ${s}`) : ["  no failed attempts"]),
  ].join("\n");
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const { values } = parseArgs({ options: { allow: { type: "string" }, block: { type: "string" }, show: { type: "string" } } });
  const url = process.env.DATABASE_URL;
  if (!url) { console.error("DATABASE_URL is required"); process.exit(2); }
  const chosen = [values.allow, values.block, values.show].filter((v) => v !== undefined).length;
  if (chosen !== 1) { console.error('usage: pnpm show:screening --allow "<text>" | --block "<text>" | --show <YYYY-MM-DD>'); process.exit(2); }
  const db = createClient(url);
  try {
    if (values.show) console.log(await weekReport(db, parseWeekArg(values.show)));
    else {
      await setVerdict(db, (values.allow ?? values.block)!, values.allow !== undefined ? "allow" : "block");
      console.log("saved. An episode already scripted keeps its old verdict until `pnpm run show --week <date> --force`.");
    }
  } finally {
    await db.$client.end();
  }
}
```

Verify that `PgScreeningStore.put`'s conflict clause lets an `operator` row replace an `operator` row (test 2 above). If it refuses, adjust its `where` to allow `excluded.source = 'operator'`, and keep the existing store tests green.

- [ ] **Step 6: Wire the scripts**

`apps/show/package.json` scripts:

```json
"screening": "tsx src/ops/screening-cli.ts",
"backfill-pronunciations": "tsx src/ops/backfill-cli.ts"
```

Root `package.json` scripts, beside `"show"`:

```json
"show:screening": "pnpm --filter @factions/show run screening",
"show:backfill-pronunciations": "pnpm --filter @factions/show run backfill-pronunciations",
"show:youtube-auth": "pnpm --filter @factions/show run youtube-auth"
```

- [ ] **Step 7: Run to verify they pass**

Run: `cd apps/show && TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions" npx vitest run && npx tsc --noEmit -p .`

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add apps/show/src/ops apps/show/test/ops apps/show/package.json package.json apps/show/src/screening/store.ts
git commit -m "feat(show): screening overrides and pronunciation backfill commands"
```

---

### Task 12: Deploy units, runbook, docs, vocabulary check, changelog

**Files:**
- Create: `deploy/systemd/clan-wars-show.service`, `deploy/systemd/clan-wars-show.timer`, `docs/deploy/2026-09-26-weekly-show.md`
- Modify: `apps/show/README.md` (create if absent), `CLAUDE.md` (the weekly show row), `apps/bot/test/vocabulary.test.ts`, `CHANGELOG.md`
- Test: `apps/bot/test/vocabulary.test.ts`, `apps/show/test/deploy-units.test.ts`

- [ ] **Step 1: Write the failing unit-file test**

`apps/show/test/deploy-units.test.ts`:

```ts
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const unit = (f: string) => fs.readFileSync(path.join(ROOT, "deploy", "systemd", f), "utf8");

describe("clan-wars-show units (spec §2.5, §14)", () => {
  it("is a low-priority oneshot under acab with the shared env file", () => {
    const s = unit("clan-wars-show.service");
    for (const line of ["Type=oneshot", "User=acab", "WorkingDirectory=/opt/clan-wars", "EnvironmentFile=/opt/clan-wars/.env", "Nice=10", "IOSchedulingClass=idle", "StateDirectory=clan-wars-show"]) {
      expect(s).toContain(line);
    }
    expect(s).toMatch(/^ExecStart=\/home\/acab\/\.local\/bin\/pnpm --filter @factions\/show start$/mu);
    expect(s).not.toMatch(/^Restart=/mu); // a failed run waits for the next timer tick
  });
  it("fires every 10 minutes and catches up after downtime", () => {
    const t = unit("clan-wars-show.timer");
    expect(t).toContain("OnCalendar=*:0/10");
    expect(t).toContain("Persistent=true");
  });
});
```

- [ ] **Step 2: Add the `apps/show` walk to the vocabulary check (failing until the files exist)**

In `apps/bot/test/vocabulary.test.ts`, after the `packages/copy/src` block, add:

```ts
// Spec §15: the weekly show's published text (titles, forum posts, captions, the prompt that
// writes the script) says clan too. Listed by file, since most of apps/show is not copy.
const SHOW_SRC_ROOT = resolve(here, "..", "..", "show", "src");
const SHOW_PLAYER_FACING = [
  "stages/text.ts",
  "prompt/system.ts",
  "engine/publish/youtube/buildVideoMeta.ts",
  "engine/publish/facebook/buildFacebookCaption.ts",
  "cards/cards.ts",
];

describe("apps/show published text says clan, not faction", () => {
  for (const file of SHOW_PLAYER_FACING) {
    it(file, () => {
      expect(offendersIn(readFileSync(join(SHOW_SRC_ROOT, file), "utf8"))).toEqual([]);
    });
  }
});
```

- [ ] **Step 3: Run to verify they fail**

Run: `cd apps/show && npx vitest run test/deploy-units.test.ts` (FAIL: no unit files), then `cd apps/bot && TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions" npx vitest run test/vocabulary.test.ts`.

Expected: the vocabulary check PASSES, since those files already say clan. If one fails, fix the copy, not the test.

- [ ] **Step 4: Write the units**

`deploy/systemd/clan-wars-show.service`:

```ini
[Unit]
# The weekly Bloodbag and Painkiller Show (apps/show): one run per timer tick. A run with
# nothing to do exits in milliseconds; a run that renders takes minutes of ffmpeg and resvg.
# systemd never starts a second instance of an active oneshot, and a manual
# `pnpm run show` takes the same advisory lock, so runs cannot overlap (spec §2.5).
Description=Clan Wars weekly show
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
User=acab
WorkingDirectory=/opt/clan-wars
# ⚠️ Same three-parser caveat as clan-wars-bot.service: keep .env plain.
EnvironmentFile=/opt/clan-wars/.env
# ⚠️ Behind the four production sites on this host: a render must never slow them.
Nice=10
IOSchedulingClass=idle
# /var/lib/clan-wars-show, owned by acab: SHOW_CACHE_DIR's default.
StateDirectory=clan-wars-show
ExecStart=/home/acab/.local/bin/pnpm --filter @factions/show start
StandardOutput=journal
StandardError=journal
```

`deploy/systemd/clan-wars-show.timer`:

```ini
[Unit]
Description=Every 10 minutes: the weekly show

[Timer]
OnCalendar=*:0/10
Persistent=true

[Install]
WantedBy=timers.target
```

- [ ] **Step 5: Write the runbook `docs/deploy/2026-09-26-weekly-show.md`**

The runbook must contain these sections, in this order, each with exact commands:

1. **What this deploys**: the migration (0053, already shipped with plan 1), the service and timer, and the new env keys. Off until `SHOW_ENABLED=1`.
2. **Host prerequisites**: `which ffmpeg rhubarb`, both on `acab`'s PATH or set via `FFMPEG_PATH` and `RHUBARB_PATH`. `/var/lib/clan-wars-show` comes from `StateDirectory`.
3. **Mint the YouTube token**:
   - The Google Cloud OAuth client is the KOTH show's Desktop client.
   - Run `set -a && . ./.env && set +a && pnpm show:youtube-auth`, then approve in a browser signed in to the show's channel.
   - Put `YOUTUBE_REFRESH_TOKEN=` in `/opt/clan-wars/.env`.
   - The KOTH bot's token is untouched.
4. **Create the playlist**: "Clan Wars" on the channel in YouTube Studio. Copy its id (the `PL...` in the URL) into `YOUTUBE_PLAYLIST_ID`.
5. **Env keys**: the table from spec §13 with this deploy's values:
   - `SHOW_FORUM_CHANNEL_ID=1553136654808784986`.
   - `SHOW_APPROVER_DISCORD_IDS`: the admins.
   - The ElevenLabs key and voice ids, and the Facebook page id and token, copied from `/opt/deathmatch-bot/.env`.
   - `SHOW_ENABLED` stays unset for now.
   - Never paste values into a ticket or chat.
6. **Bot permissions**: the bot needs View Channel, Send Messages, Add Reactions and Read Message History in the ops channel. In the forum it needs Create Posts, Send Messages in Threads and Attach Files. Check with a manual post before enabling.
7. **Backfill pronunciations**: `pnpm show:backfill-pronunciations --dry-run`, then without `--dry-run`.
8. **Dry run a past week**: `pnpm run show --week 2026-09-21 --dry-run`. Read the script.
9. **Render one week locally against a snapshot**: `pnpm run show --week <date> --render <dir>` on a workstation, as in plan 2. Watch it and time it (spec §16).
10. **Install and enable**:
    - `sudo ln -s /opt/clan-wars/deploy/systemd/clan-wars-show.{service,timer} /etc/systemd/system/`
    - `sudo systemctl daemon-reload`
    - Set `SHOW_ENABLED=1` (approval stays on by default).
    - `sudo systemctl enable --now clan-wars-show.timer`
    - `journalctl -u clan-wars-show -f`
11. **Approving an episode**: react ✅ or ❌ on the draft in the ops channel. Only `SHOW_APPROVER_DISCORD_IDS` count. ❌ wins over ✅.
    - ⚠️ An episode waiting for approval holds back every later week (spec §8.1).
    - The plan is to keep approval on for the first four episodes, then set `SHOW_REQUIRE_APPROVAL=0`.
12. **When something goes wrong**:
    - `held`: `pnpm show:screening --show <date>` shows the raw reasons, in the terminal only. Then `--allow`/`--block`, then `pnpm run show --week <date> --force`.
    - A stuck stage: the alert fires at 3 attempts. Read `last_error` with a read-only `select stage, attempts, last_error from show_episodes order by week_start desc limit 3`.
    - A public episode needs `--force --repost`. The old YouTube video stays until it is deleted by hand.
    - A Facebook failure shows as `last_error` on a `done` row and is not retried.
13. **Turning it off**: `sudo systemctl disable --now clan-wars-show.timer`, or unset `SHOW_ENABLED`.

- [ ] **Step 6: Update docs**

- `apps/show/README.md`:
  - What the app does.
  - The commands from spec §10, with `pnpm run show`, never `pnpm show`.
  - The full env table from spec §13, plus `DISCORD_GUILD_ID`, noting why.
  - A pointer to the runbook.
- `CLAUDE.md`: extend the "weekly show" row in "Where things live" to name the following, in the file's existing style:
  - `src/stages/` (the state machine) and `src/engine/publish/`.
  - The units and the runbook.
  - These warnings:
    - ⚠️ ops posts carry no raw blocked text.
    - ⚠️ an awaiting-approval episode blocks later weeks.
    - ⚠️ `pnpm run show`, not `pnpm show`.
- `CHANGELOG.md`: add a line under `## [Unreleased]` → `### Added`: `The Bloodbag and Painkiller Show now airs a weekly Clan Wars episode: posted to YouTube, the show's forum channel and Facebook after an admin approves it in the ops channel.`

- [ ] **Step 7: Run the full gate**

Run: `TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions" npx turbo run typecheck test --concurrency=1 --force`

Expected: `Tasks: 32 successful, 32 total`.

- [ ] **Step 8: Commit**

```bash
git add deploy/systemd/clan-wars-show.service deploy/systemd/clan-wars-show.timer docs/deploy/2026-09-26-weekly-show.md apps/show/README.md CLAUDE.md CHANGELOG.md apps/bot/test/vocabulary.test.ts apps/show/test/deploy-units.test.ts
git commit -m "docs(show): systemd units, runbook, README and changelog for the weekly show"
```

---

## Self-review notes

- **Spec coverage:**

  | Spec section | Where it lands |
  |---|---|
  | §2.4 titles | Tasks 5, 7 |
  | §2.5 timer/oneshot/nice | Task 12 |
  | §2.5 lock | Tasks 2, 10 |
  | §2.6 approval default on | Task 2 |
  | §8.1 run and picker | Tasks 3, 10 |
  | §8.2 stage order and approval-off path | Tasks 8, 9 |
  | §8.3 idempotency, cache reuse, alerts, Facebook best-effort | Tasks 8, 9 |
  | §9.1 upload, playlist, poll, privacy | Tasks 5, 9 |
  | §9.2 reactions | Task 9 |
  | §9.3 forum | Tasks 7, 9 |
  | §9.4 Facebook | Tasks 6, 9 |
  | §10 commands | Tasks 10, 11 (and Task 5 for youtube-auth) |
  | §13 keys | Task 2 |
  | §14 units and runbook | Task 12 |
  | §15 stage tests and vocabulary | Tasks 8, 9, 12 |

- **Type names across tasks:**
  - `StageDeps`, `YouTubeOps`, `FacebookOps`, `StoredReport`, `EpisodeRow`, `Discord` and `OutMessage` are defined once and used by name.
  - `ensureInPlaylist` is the name in both the fakes and `realDeps`.
  - `transcriptMessages` takes `{ narrative, names, mp3 }` everywhere.
