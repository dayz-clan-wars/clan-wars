# Booster Clothing Kits Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Discord server booster picks seven clothing pieces on the site, places them anywhere on the map by performing an emote there, and the kit respawns at that spot every reboot for as long as they keep boosting.

**Architecture:** Two halves. The bot projects Discord boost status into `discord_boosters` and witnesses a three-emote placement challenge to capture a spot. The ingest worker regenerates `booster-kits.json` in full from current eligible boosters, hashes it, and uploads it through the existing `syncProjection` helper. Nothing ever deletes a kit: losing eligibility means falling out of the next regeneration.

**Tech Stack:** TypeScript, pnpm workspace + turbo, vitest, drizzle-orm over postgres.js, discord.js, Next.js (web), Nitrado API.

**Spec:** `docs/superpowers/specs/2026-09-19-booster-kits-design.md`

## Global Constraints

- **Console server, no mods.** The only spawning mechanism is vanilla `cfggameplay.json` `WorldsData.objectSpawnersArr`. See `docs/direction/2026-09-13-console-init-c-findings.md`.
- **Never write `cfggameplay.json` from code.** Adding `./custom/booster-kits.json` to `objectSpawnersArr` is a one-time manual deploy step (Task 9).
- **All ten kit items spawn at the identical position.** No offsets, no arrangement, no template asset.
- **Coordinates are ALREADY normalised — do not convert anything.** The ADM line reads `pos=<x, z, altitude>`, but `parsePlayerPos` does not return a tuple in that order: it returns `Vec3`, which is `{ x, y, z }` with **`y` ALWAYS altitude** (`packages/domain/src/vec3.ts`). So `payload.pos.y` is altitude, already matching `declarations.y` and the spawner JSON's middle slot. Task 5 writes `posX = pos.x, posY = pos.y, posZ = pos.z` with no reordering, and Task 6 writes `[k.x, k.y, k.z]` with no reordering. ⚠️ Any code that destructures `pos` as an array, or that swaps y and z "to convert ADM order", is WRONG and puts every kit underground.
- **Drizzle numeric columns arrive as strings.** Every coordinate read from the database goes through `Number()` before arithmetic or serialisation, or coordinates silently concatenate.
- **Deterministic bytes.** The generated file is hashed. Any ordering must be total and stable, or the tick re-uploads forever.
- **The armband is derived, never stored.** `armbandFor(texture)` in `packages/domain/src/flags.ts`.
- **No `dayz_id` column on `booster_kits`.** The character is joined from `identity_links` on `discord_id`.
- **Kit contents are cosmetic only.** Nine clothing slots plus the armband. No weapons, no ammunition, containers spawn empty.
- **Player-facing copy:** plain voice, no em dashes, and nothing framing the kit as protected or off-limits.

---

### Task 1: Emote events carry the player's position

The persisted `emote.performed` payload currently holds `gamertag`, `dayzId`, `emote`, `item` and no position, so there is nothing for a placement challenge to read. Every other positional ADM event already does this by calling `parsePlayerPos` on the same raw line.

**Files:**
- Modify: `packages/adm-parser/src/emote.ts`
- Modify: `apps/ingest-worker/src/ingest.ts:167-172` (the `case "emote"` payload)
- Test: `packages/adm-parser/test/emote.test.ts`

**Interfaces:**
- Consumes: `parsePlayerPos(raw: string): Vec3 | null` from `./coords.js`
- Produces: `EmotePerformed` gains `pos: Vec3 | null`; the `emote.performed` event payload gains `pos`

- [ ] **Step 1: Write the failing tests**

```ts
// packages/adm-parser/test/emote.test.ts
import { describe, expect, it } from "vitest";
import { parseEmote } from "../src/emote.js";

const LINE =
  `01:02:03 | Player "Bob" (id=${"A".repeat(40)} pos=<5572.7, 8811.8, 312.8>) performed EmoteSalute`;

describe("parseEmote position", () => {
  it("captures the player position from the identity block", () => {
    expect(parseEmote(LINE)?.pos).toEqual([5572.7, 8811.8, 312.8]);
  });

  it("is null when the line carries no position", () => {
    const noPos = `01:02:03 | Player "Bob" (id=${"A".repeat(40)}) performed EmoteSalute`;
    expect(parseEmote(noPos)?.pos).toBeNull();
  });

  it("ignores a pos worn in the gamertag", () => {
    const hostile =
      `01:02:03 | Player "pos=<1.0, 2.0, 3.0>" (id=${"A".repeat(40)} pos=<5572.7, 8811.8, 312.8>) performed EmoteSalute`;
    expect(parseEmote(hostile)?.pos).toEqual([5572.7, 8811.8, 312.8]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @factions/adm-parser test -- emote`
Expected: FAIL, `pos` is undefined on the parsed result.

- [ ] **Step 3: Add the position to the parser**

In `packages/adm-parser/src/emote.ts`, import `parsePlayerPos` and add the field. The existing `EMOTE_RE` anchoring is unchanged and must stay anchored to the `(id=...)` block.

```ts
import { parsePlayerPos } from "./coords.js";
import type { Vec3 } from "@factions/domain";

export type EmotePerformed = {
  gamertag: string;
  dayzId: string;
  emote: string;
  item: string | null;
  /**
   * Where the player stood, in ADM order <x, z, altitude>. Null when the line
   * carries no position block.
   *
   * ⚠️ Read by the booster kit placement challenge, which writes it to the
   * map. parsePlayerPos is anchored INSIDE the identity parenthetical for
   * exactly this reason: unanchored, a gamertag carrying a pos block moves
   * someone else's kit.
   */
  pos: Vec3 | null;
};
```

and in the returned object:

```ts
  return {
    gamertag: who.gamertag,
    dayzId: who.dayzId,
    emote: m[1]!,
    item: m[2] != null ? m[2].trim() : null,
    pos: parsePlayerPos(raw),
  };
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @factions/adm-parser test -- emote`
Expected: PASS.

- [ ] **Step 5: Carry the position into the persisted payload**

In `apps/ingest-worker/src/ingest.ts`, the `case "emote"` branch:

```ts
    case "emote":
      return {
        gamertag: line.event.gamertag,
        dayzId: line.event.dayzId,
        emote: line.event.emote,
        item: line.event.item,
        pos: line.event.pos,
      };
```

- [ ] **Step 6: Run the full parser and ingest suites**

Run: `pnpm --filter @factions/adm-parser test && pnpm --filter ingest-worker test`
Expected: PASS. Existing emote fixtures gain a `pos` field; update any snapshot that asserts the whole payload.

- [ ] **Step 7: Commit**

```bash
git add packages/adm-parser/src/emote.ts packages/adm-parser/test/emote.test.ts apps/ingest-worker/src/ingest.ts
git commit -m "feat(adm-parser): emote events carry the player position"
```

---

### Task 2: Kit slots, the catalogue, and validation

**Prerequisite input:** the curated catalogue contents are agreed in a separate picking session before this task runs (see "Catalogue sourcing" at the end of this plan). This task builds the loader and validator, which are testable with fixtures and do not depend on which items were chosen.

**Files:**
- Create: `packages/domain/src/booster-kit.ts`
- Create: `packages/domain/assets/booster-catalogue.json`
- Modify: `packages/domain/src/index.ts` (re-export)
- Test: `packages/domain/test/booster-kit.test.ts`

**Interfaces:**
- Produces:
  - `KIT_SLOTS: readonly KitSlot[]` — `["mask","jacket","pants","boots","gloves","hipPack","backpack"]`
  - `type KitSlot = (typeof KIT_SLOTS)[number]`
  - `type CatalogueEntry = { className: string; label: string }`
  - `type Catalogue = Record<KitSlot, CatalogueEntry[]>`
  - `loadCatalogue(json: unknown): Catalogue`
  - `isAllowed(catalogue: Catalogue, slot: KitSlot, className: string): boolean`

- [ ] **Step 1: Write the failing tests**

```ts
// packages/domain/test/booster-kit.test.ts
import { describe, expect, it } from "vitest";
import { KIT_SLOTS, loadCatalogue, isAllowed } from "../src/booster-kit.js";

const GOOD = {
  mask: [{ className: "GasMask", label: "Gas Mask" }],
  jacket: [{ className: "GorkaEJacket_Summer", label: "Gorka Jacket" }],
  eyewear: [], hat: [], pants: [], boots: [], gloves: [], hipPack: [], backpack: [],
};

describe("loadCatalogue", () => {
  it("accepts a file with an entry list for every slot", () => {
    const c = loadCatalogue(GOOD);
    expect(Object.keys(c).sort()).toEqual([...KIT_SLOTS].sort());
  });

  it("throws when a slot is missing, naming it", () => {
    const { backpack, ...missing } = GOOD;
    expect(() => loadCatalogue(missing)).toThrow(/backpack/);
  });

  it("throws on a duplicate class name within a slot", () => {
    const dup = { ...GOOD, mask: [...GOOD.mask, { className: "GasMask", label: "Again" }] };
    expect(() => loadCatalogue(dup)).toThrow(/GasMask/);
  });
});

describe("isAllowed", () => {
  it("is true for a class name in that slot", () => {
    expect(isAllowed(loadCatalogue(GOOD), "mask", "GasMask")).toBe(true);
  });

  it("is false for a class name from a different slot", () => {
    expect(isAllowed(loadCatalogue(GOOD), "mask", "GorkaEJacket_Summer")).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @factions/domain test -- booster-kit`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement**

```ts
// packages/domain/src/booster-kit.ts

/**
 * The nine slots a booster chooses. The tenth item in a kit is the clan
 * armband, which is DERIVED from the faction's texture (armbandFor) and is
 * deliberately not a slot: storing it would go stale the moment a clan
 * changes flag.
 */
export const KIT_SLOTS = ["mask", "eyewear", "hat", "jacket", "pants", "boots", "gloves", "hipPack", "backpack"] as const;
export type KitSlot = (typeof KIT_SLOTS)[number];

export type CatalogueEntry = { className: string; label: string };
export type Catalogue = Record<KitSlot, CatalogueEntry[]>;

/**
 * Parse and check the committed catalogue.
 *
 * ⚠️ Throws rather than repairing. This file is the ONLY validator of what a
 * booster may pick; a silently-dropped slot would let the picker accept
 * anything for it, and a duplicate class name would render two identical
 * options a player cannot tell apart.
 */
export function loadCatalogue(json: unknown): Catalogue {
  const raw = json as Record<string, unknown>;
  const out = {} as Catalogue;
  for (const slot of KIT_SLOTS) {
    const list = raw?.[slot];
    if (!Array.isArray(list)) throw new Error(`booster catalogue: slot ${slot} is missing or not a list`);
    const seen = new Set<string>();
    for (const e of list as CatalogueEntry[]) {
      if (typeof e?.className !== "string" || typeof e?.label !== "string") {
        throw new Error(`booster catalogue: slot ${slot} has an entry without className and label`);
      }
      if (seen.has(e.className)) throw new Error(`booster catalogue: slot ${slot} lists ${e.className} twice`);
      seen.add(e.className);
    }
    out[slot] = list as CatalogueEntry[];
  }
  return out;
}

export function isAllowed(catalogue: Catalogue, slot: KitSlot, className: string): boolean {
  return catalogue[slot].some((e) => e.className === className);
}
```

Create `packages/domain/assets/booster-catalogue.json` with the agreed entries, one key per slot. Re-export from `packages/domain/src/index.ts`:

```ts
export * from "./booster-kit.js";
```

- [ ] **Step 4: Run to verify pass**

Run: `pnpm --filter @factions/domain test -- booster-kit`
Expected: PASS.

- [ ] **Step 5: Add a test that the committed catalogue itself loads**

```ts
// append to packages/domain/test/booster-kit.test.ts
import catalogue from "../assets/booster-catalogue.json" with { type: "json" };

it("the committed catalogue is valid", () => {
  expect(() => loadCatalogue(catalogue)).not.toThrow();
});
```

Run: `pnpm --filter @factions/domain test -- booster-kit`
Expected: PASS. This is the guard that a bad hand edit to the catalogue fails CI rather than production.

- [ ] **Step 6: Commit**

```bash
git add packages/domain/src/booster-kit.ts packages/domain/src/index.ts packages/domain/assets/booster-catalogue.json packages/domain/test/booster-kit.test.ts
git commit -m "feat(domain): booster kit slots and curated catalogue"
```

---

### Task 3: Schema and migration

**Files:**
- Modify: `packages/db/src/schema.ts`
- Create: migration under `packages/db/drizzle/` (generated)
- Test: `packages/db/test/booster-kits.test.ts`

**Interfaces:**
- Produces: `boosterKits`, `discordBoosters`, `boosterKitUploads`, `boosterKitChallenges` table exports

- [ ] **Step 1: Add the tables to the schema**

Follow the surrounding style in `schema.ts`. `boosterKitUploads` copies `supplyUploads` column for column so it can share `storeFor()`.

```ts
/**
 * One booster's kit. Keyed by Discord account, because the BOOST is a property
 * of the Discord account, not of a character.
 *
 * ⚠️ No dayz_id column, on purpose. The character is joined from
 * identity_links on discord_id. Copying it here would leave a kit bound to a
 * character the player has since unlinked, and something would have to
 * remember to rewrite it. Joining makes unlinking remove the kit by itself.
 *
 * Position is null until the first placement emote is witnessed. A configured
 * but unplaced kit generates nothing.
 */
export const boosterKits = pgTable("booster_kits", {
  discordId: text("discord_id").primaryKey(),
  posX: doublePrecision("pos_x"),
  posY: doublePrecision("pos_y"),
  posZ: doublePrecision("pos_z"),
  mask: text("mask"),
  eyewear: text("eyewear"),
  hat: text("hat"),
  jacket: text("jacket"),
  pants: text("pants"),
  boots: text("boots"),
  gloves: text("gloves"),
  hipPack: text("hip_pack"),
  backpack: text("backpack"),
  placedAt: timestamp("placed_at", { withTimezone: true }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Who is boosting, as last observed from Discord. Written by the bot's
 * booster tick, read by the ingest worker, which has no Discord client and
 * should not grow one.
 *
 * ⚠️ Rows are DELETED when someone stops boosting, not flagged. The kit
 * projection tests for presence, so a soft-delete flag would be one more
 * thing every reader must remember to filter.
 */
export const discordBoosters = pgTable("discord_boosters", {
  discordId: text("discord_id").primaryKey(),
  premiumSince: timestamp("premium_since", { withTimezone: true }).notNull(),
  observedAt: timestamp("observed_at", { withTimezone: true }).notNull(),
});

/** Same columns as supply_uploads, so storeFor() serves both. One table per
 *  projected file, so the two files' hashes and baselines cannot cross. */
export const boosterKitUploads = pgTable("booster_kit_uploads", {
  serverId: integer("server_id").primaryKey(),
  contentHash: text("content_hash").notNull(),
  uploadedAt: timestamp("uploaded_at", { withTimezone: true }).notNull(),
  remoteSize: integer("remote_size"),
  remoteModifiedAt: timestamp("remote_modified_at", { withTimezone: true }),
});

/**
 * A live placement challenge. Separate from the link challenge tables because
 * it proves something different: link binds an account to a character, this
 * binds a LOCATION to an existing kit. Reusing the link challenge would make
 * "already-linked" and "taken" outcomes meaningful here, which they are not.
 */
export const boosterKitChallenges = pgTable("booster_kit_challenges", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  discordId: text("discord_id").notNull(),
  targetDayzId: text("target_dayz_id").notNull(),
  sequence: text("sequence").array().notNull(),
  progressIndex: integer("progress_index").notNull().default(0),
  seenCount: integer("seen_count").notNull().default(0),
  lastMatchedEventId: bigint("last_matched_event_id", { mode: "number" }).notNull().default(0),
  issuedAt: timestamp("issued_at", { withTimezone: true }).notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  closedAt: timestamp("closed_at", { withTimezone: true }),
}, (t) => ({
  // One open challenge per account. Partial, so closed rows do not collide.
  openPerAccount: uniqueIndex("booster_kit_challenges_open_uniq")
    .on(t.discordId).where(sql`${t.closedAt} IS NULL`),
}));
```

- [ ] **Step 2: Generate the migration**

Run: `pnpm --filter @factions/db generate`
Expected: a new numbered migration appears under `packages/db/drizzle/`. Read it before committing and confirm it only creates these four tables and the one partial index.

- [ ] **Step 3: Write a test that the tables round-trip**

```ts
// packages/db/test/booster-kits.test.ts
import { describe, expect, it } from "vitest";
import { boosterKits, discordBoosters } from "../src/schema.js";
import { testDb } from "../src/test-setup.js"; // follow the pattern in the sibling suites

describe("booster kit tables", () => {
  it("stores a kit with no position", async () => {
    const db = await testDb();
    await db.insert(boosterKits).values({ discordId: "1", mask: "GasMask" });
    const [row] = await db.select().from(boosterKits);
    expect(row?.posX).toBeNull();
    expect(row?.mask).toBe("GasMask");
  });

  it("holds one booster row per account", async () => {
    const db = await testDb();
    const now = new Date();
    await db.insert(discordBoosters).values({ discordId: "1", premiumSince: now, observedAt: now });
    await expect(
      db.insert(discordBoosters).values({ discordId: "1", premiumSince: now, observedAt: now }),
    ).rejects.toThrow();
  });
});
```

Match the existing suites' setup helper exactly; read `packages/db/test/supply-uploads.test.ts` first rather than assuming the import above.

- [ ] **Step 4: Run the tests**

Run: `pnpm --filter @factions/db test -- booster-kits`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/db/src/schema.ts packages/db/drizzle packages/db/test/booster-kits.test.ts
git commit -m "feat(db): booster kit, booster status, challenge and upload tables"
```

---

### Task 4: The bot's booster status tick

**Files:**
- Create: `apps/bot/src/booster-tick.ts`
- Modify: wherever the bot schedules its recurring ticks (find it by reading `apps/bot/src/launch.ts` and following how `restart-tick` is scheduled)
- Test: `apps/bot/test/booster-tick.test.ts`

**Interfaces:**
- Consumes: `discordBoosters` from Task 3
- Produces: `boosterTick(db, deps): Promise<BoosterTickResult>`, `type BoosterSource = { fetchBoosters(): Promise<{ discordId: string; premiumSince: Date }[]> }`

- [ ] **Step 1: Write the failing tests**

```ts
// apps/bot/test/booster-tick.test.ts
import { describe, expect, it } from "vitest";
import { boosterTick } from "../src/booster-tick.js";
import { discordBoosters } from "@factions/db";

const source = (list: { discordId: string; premiumSince: Date }[]) => ({
  fetchBoosters: async () => list,
});

describe("boosterTick", () => {
  it("inserts a row per current booster", async () => {
    const db = await testDb();
    const since = new Date("2026-09-18T00:00:00Z");
    const r = await boosterTick(db, { source: source([{ discordId: "1", premiumSince: since }]), now: new Date() });
    expect(r).toEqual({ boosters: 1, added: 1, removed: 0 });
  });

  it("deletes rows for anyone no longer boosting", async () => {
    const db = await testDb();
    const since = new Date("2026-09-18T00:00:00Z");
    await boosterTick(db, { source: source([{ discordId: "1", premiumSince: since }]), now: new Date() });
    const r = await boosterTick(db, { source: source([]), now: new Date() });
    expect(r.removed).toBe(1);
    expect(await db.select().from(discordBoosters)).toEqual([]);
  });

  it("is idempotent when nothing changed", async () => {
    const db = await testDb();
    const since = new Date("2026-09-18T00:00:00Z");
    const list = [{ discordId: "1", premiumSince: since }];
    await boosterTick(db, { source: source(list), now: new Date() });
    const r = await boosterTick(db, { source: source(list), now: new Date() });
    expect(r).toEqual({ boosters: 1, added: 0, removed: 0 });
  });

  it("does not delete anyone when the fetch throws", async () => {
    const db = await testDb();
    const since = new Date("2026-09-18T00:00:00Z");
    await boosterTick(db, { source: source([{ discordId: "1", premiumSince: since }]), now: new Date() });
    const failing = { fetchBoosters: async () => { throw new Error("gateway down"); } };
    await expect(boosterTick(db, { source: failing, now: new Date() })).rejects.toThrow();
    expect(await db.select().from(discordBoosters)).toHaveLength(1);
  });
});
```

The last test is the important one: a Discord outage that returned an empty list would otherwise revoke every kit on the server.

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter bot test -- booster-tick`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement**

```ts
// apps/bot/src/booster-tick.ts
import { discordBoosters, type Database } from "@factions/db";
import { inArray, notInArray } from "drizzle-orm";

/** What the tick needs from Discord, so a test can hand it a fake. */
export type BoosterSource = {
  fetchBoosters(): Promise<{ discordId: string; premiumSince: Date }[]>;
};

export type BoosterTickResult = { boosters: number; added: number; removed: number };

/**
 * Mirror the guild's current boosters into `discord_boosters`.
 *
 * ⚠️ Level-triggered: every run recomputes the whole set rather than reacting
 * to gateway events. A missed GuildMemberUpdate or a skipped run heals on the
 * next pass instead of leaving a phantom booster holding a kit forever.
 *
 * ⚠️ The fetch is awaited BEFORE anything is deleted, and a throw propagates
 * untouched. A Discord outage that resolved to an empty list would otherwise
 * revoke every kit on the server at the next restart.
 */
export async function boosterTick(db: Database, deps: {
  source: BoosterSource;
  now: Date;
}): Promise<BoosterTickResult> {
  const current = await deps.source.fetchBoosters();
  const ids = current.map((b) => b.discordId);

  const before = await db.select({ discordId: discordBoosters.discordId }).from(discordBoosters);
  const had = new Set(before.map((r) => r.discordId));

  for (const b of current) {
    await db.insert(discordBoosters)
      .values({ discordId: b.discordId, premiumSince: b.premiumSince, observedAt: deps.now })
      .onConflictDoUpdate({
        target: discordBoosters.discordId,
        set: { premiumSince: b.premiumSince, observedAt: deps.now },
      });
  }

  // ⚠️ An empty `ids` means nobody is boosting, which is a legitimate state and
  // must clear the table. notInArray with an empty list does not do that in
  // every dialect, so the empty case is spelled out.
  const removed = ids.length === 0
    ? (await db.delete(discordBoosters).returning({ id: discordBoosters.discordId })).length
    : (await db.delete(discordBoosters).where(notInArray(discordBoosters.discordId, ids))
        .returning({ id: discordBoosters.discordId })).length;

  return {
    boosters: current.length,
    added: current.filter((b) => !had.has(b.discordId)).length,
    removed,
  };
}
```

- [ ] **Step 4: Run to verify pass**

Run: `pnpm --filter bot test -- booster-tick`
Expected: PASS.

- [ ] **Step 5: Wire the real source and schedule the tick**

The live source fetches members and reads `premiumSince`. The `GuildMembers` intent is already requested at `apps/bot/src/discord.ts:593`.

```ts
export function guildBoosterSource(guild: Guild): BoosterSource {
  return {
    async fetchBoosters() {
      const members = await guild.members.fetch();
      return [...members.values()]
        .filter((m) => m.premiumSince !== null)
        .map((m) => ({ discordId: m.id, premiumSince: m.premiumSince! }));
    },
  };
}
```

Schedule it alongside the bot's other ticks. Read how `restart-tick` is registered and follow that shape exactly. A 15 minute interval is appropriate: the effect is bounded by the next server restart anyway, and `guild.members.fetch()` is a heavy call.

- [ ] **Step 6: Run the whole bot suite**

Run: `pnpm --filter bot test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/bot/src/booster-tick.ts apps/bot/test/booster-tick.test.ts
git commit -m "feat(bot): project Discord boost status into discord_boosters"
```

---

### Task 5: The placement challenge

Issues a three-emote sequence bound to a character, witnesses it in the event log, and writes the position from the final emote to the kit row.

**Files:**
- Create: `apps/bot/src/kit-placement-tick.ts`
- Create: `apps/bot/src/kit-placement-issue.ts`
- Test: `apps/bot/test/kit-placement-tick.test.ts`

**Interfaces:**
- Consumes: `advance` and `generateSequence` from `@factions/verification`, `safeVerificationEmotes` from `@factions/domain`, `readCursor` / `writeCursor` / `readEventBatch` from `@factions/event-log`, `boosterKitChallenges` and `boosterKits` from Task 3, the `pos` field from Task 1
- Produces: `issuePlacementChallenge(db, { discordId, now, ttlMs, rng }): Promise<{ sequence: string[]; expiresAt: Date } | null>`, `kitPlacementTick(db, opts): Promise<KitPlacementResult>`, `KIT_PLACEMENT_CONSUMER = "kit-placement"`

- [ ] **Step 1: Write the failing tests**

```ts
// apps/bot/test/kit-placement-tick.test.ts
import { describe, expect, it } from "vitest";
import { kitPlacementTick } from "../src/kit-placement-tick.js";
import { boosterKits, boosterKitChallenges } from "@factions/db";

// Helpers: seedChallenge(db, {discordId, dayzId, sequence, issuedAt}) and
// appendEmote(db, {dayzId, emote, pos, occurredAt}) write a challenge row and an
// emote.performed event respectively. Follow apps/bot/test/tick.test.ts for the
// exact event-log seeding helpers already in use.

describe("kitPlacementTick", () => {
  it("writes the position of the FINAL emote in the sequence", async () => {
    const db = await testDb();
    await db.insert(boosterKits).values({ discordId: "1", mask: "GasMask" });
    await seedChallenge(db, { discordId: "1", dayzId: "A".repeat(40), sequence: ["EmoteSalute", "EmoteClap"] });
    await appendEmote(db, { dayzId: "A".repeat(40), emote: "EmoteSalute", pos: { x: 100, z: 200, y: 5 } });
    await appendEmote(db, { dayzId: "A".repeat(40), emote: "EmoteClap", pos: { x: 300, z: 400, y: 6 } });

    const r = await kitPlacementTick(db, { now: new Date() });

    expect(r.placed).toBe(1);
    const [kit] = await db.select().from(boosterKits);
    // parsePlayerPos already normalised the line's <300, 400, 6> into
    // { x: 300, z: 400, y: 6 }. The columns take it as-is.
    expect([Number(kit!.posX), Number(kit!.posY), Number(kit!.posZ)]).toEqual([300, 6, 400]);
  });

  it("ignores emotes from a character the challenge does not name", async () => {
    const db = await testDb();
    await db.insert(boosterKits).values({ discordId: "1", mask: "GasMask" });
    await seedChallenge(db, { discordId: "1", dayzId: "A".repeat(40), sequence: ["EmoteSalute"] });
    await appendEmote(db, { dayzId: "B".repeat(40), emote: "EmoteSalute", pos: { x: 300, z: 400, y: 6 } });

    const r = await kitPlacementTick(db, { now: new Date() });

    expect(r.placed).toBe(0);
    const [kit] = await db.select().from(boosterKits);
    expect(kit!.posX).toBeNull();
  });

  it("does not place when the completing emote carries no position", async () => {
    const db = await testDb();
    await db.insert(boosterKits).values({ discordId: "1", mask: "GasMask" });
    await seedChallenge(db, { discordId: "1", dayzId: "A".repeat(40), sequence: ["EmoteSalute"] });
    await appendEmote(db, { dayzId: "A".repeat(40), emote: "EmoteSalute", pos: null });

    const r = await kitPlacementTick(db, { now: new Date() });

    expect(r.placed).toBe(0);
    const [ch] = await db.select().from(boosterKitChallenges);
    expect(ch!.closedAt).toBeNull(); // still live, so they can try again where they stand
  });

  it("ignores emotes performed before the challenge was issued", async () => {
    const db = await testDb();
    await db.insert(boosterKits).values({ discordId: "1", mask: "GasMask" });
    await appendEmote(db, { dayzId: "A".repeat(40), emote: "EmoteSalute", pos: { x: 1, z: 2, y: 3 }, occurredAt: new Date("2026-09-01") });
    await seedChallenge(db, { discordId: "1", dayzId: "A".repeat(40), sequence: ["EmoteSalute"], issuedAt: new Date("2026-09-19") });

    expect((await kitPlacementTick(db, { now: new Date() })).placed).toBe(0);
  });

  it("leaves an existing spot untouched when a challenge expires", async () => {
    const db = await testDb();
    await db.insert(boosterKits).values({ discordId: "1", mask: "GasMask", posX: 9, posY: 9, posZ: 9 });
    await seedChallenge(db, {
      discordId: "1", dayzId: "A".repeat(40), sequence: ["EmoteSalute"],
      expiresAt: new Date("2026-09-01"),
    });
    await appendEmote(db, { dayzId: "A".repeat(40), emote: "EmoteSalute", pos: { x: 300, z: 400, y: 6 } });

    await kitPlacementTick(db, { now: new Date("2026-09-19") });

    const [kit] = await db.select().from(boosterKits);
    expect(Number(kit!.posX)).toBe(9);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter bot test -- kit-placement`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement the tick**

Model it closely on `apps/bot/src/tick.ts`, which is the link challenge matcher, keeping its cursor batching, its `issuedAt` guard, its target-UID comparison, its replay guard and its safe-token filter. It differs in what completion does: write a position rather than bind an identity.

```ts
// apps/bot/src/kit-placement-tick.ts
import { readCursor, writeCursor, readEventBatch } from "@factions/event-log";
import { advance } from "@factions/verification";
import { safeVerificationEmotes } from "@factions/domain";
import { boosterKits, boosterKitChallenges, type Database } from "@factions/db";
import { and, eq, isNull } from "drizzle-orm";

const SAFE_TOKENS = new Set(safeVerificationEmotes().map((e) => e.token));

/**
 * ⚠️ Its own cursor name. Sharing "identity-verifier" would make each consumer
 * skip the other's events, and the symptom is "placement randomly does not
 * work" rather than an error.
 */
export const KIT_PLACEMENT_CONSUMER = "kit-placement";

/** Same budget and the same reasoning as MAX_POOL_EMOTES_PER_ATTEMPT in tick.ts. */
export const MAX_POOL_EMOTES_PER_ATTEMPT = 8;

export type KitPlacementResult = { scanned: number; advanced: number; placed: number; lockedOut: number };
```

The body walks the batch, and for each `emote.performed` event whose payload parses:

1. Skip unless `ev.occurredAt >= challenge.issuedAt`.
2. Skip unless `payload.dayzId === challenge.targetDayzId`. This is the security boundary, same as `tick.ts`.
3. Skip unless `ev.id > challenge.lastMatchedEventId` (replay guard).
4. Skip tokens outside `SAFE_TOKENS`, which neither advance nor spend budget.
5. Skip and close the challenge when `isExpired(challenge, now)`.
6. `advance(challenge.sequence, challenge.progressIndex, payload.emote)`.
7. On `complete`: if `payload.pos` is null, leave the challenge open and count nothing, so the player can simply perform the last emote again where they are standing. Otherwise write the position and `placedAt` to the kit row, and set `closedAt`:

```ts
// `pos` is a Vec3: { x, y, z } with y ALWAYS altitude, already normalised by
// parsePlayerPos. The columns use the same convention as `declarations`, so
// nothing is reordered here. Swapping y and z "to convert ADM order" is the
// bug this comment exists to prevent.
const pos = payload.pos;
await tx.update(boosterKits)
  .set({ posX: pos.x, posY: pos.y, posZ: pos.z, placedAt: now })
  .where(eq(boosterKits.discordId, challenge.discordId));
```
8. Always persist the new `progressIndex`, `seenCount + 1` and `lastMatchedEventId`, and close the challenge when the budget is spent.

Write the position and close the challenge in one transaction. A crash between them would otherwise leave a live challenge that has already moved the kit, and the next emote would move it again.

- [ ] **Step 4: Run to verify pass**

Run: `pnpm --filter bot test -- kit-placement`
Expected: PASS.

- [ ] **Step 5: Implement issuing**

```ts
// apps/bot/src/kit-placement-issue.ts
import { generateSequence } from "@factions/verification";
import { boosterKitChallenges, identityLinks, type Database } from "@factions/db";
import { and, eq, isNull } from "drizzle-orm";

/**
 * Draw a placement challenge for this account, or null when the account is
 * not linked to a character.
 *
 * ⚠️ Closes any previous open challenge for the account first. The partial
 * unique index permits only one, and re-opening the site must not be able to
 * fail with a constraint error.
 */
export async function issuePlacementChallenge(db: Database, deps: {
  discordId: string; now: Date; ttlMs: number; rng: () => number;
}): Promise<{ sequence: string[]; expiresAt: Date } | null> {
  const [link] = await db.select({ dayzId: identityLinks.dayzId })
    .from(identityLinks).where(eq(identityLinks.discordId, deps.discordId));
  if (!link) return null;

  const sequence = generateSequence(deps.rng);
  const expiresAt = new Date(deps.now.getTime() + deps.ttlMs);

  await db.transaction(async (tx) => {
    await tx.update(boosterKitChallenges).set({ closedAt: deps.now })
      .where(and(eq(boosterKitChallenges.discordId, deps.discordId), isNull(boosterKitChallenges.closedAt)));
    await tx.insert(boosterKitChallenges).values({
      discordId: deps.discordId, targetDayzId: link.dayzId,
      sequence, issuedAt: deps.now, expiresAt,
    });
  });

  return { sequence, expiresAt };
}
```

- [ ] **Step 6: Test issuing**

```ts
it("returns null for an account with no linked character", async () => {
  const db = await testDb();
  expect(await issuePlacementChallenge(db, { discordId: "1", now: new Date(), ttlMs: 3_600_000, rng: Math.random })).toBeNull();
});

it("replaces a previous open challenge rather than colliding", async () => {
  const db = await testDb();
  await seedLink(db, { discordId: "1", dayzId: "A".repeat(40) });
  const first = await issuePlacementChallenge(db, { discordId: "1", now: new Date(), ttlMs: 3_600_000, rng: Math.random });
  const second = await issuePlacementChallenge(db, { discordId: "1", now: new Date(), ttlMs: 3_600_000, rng: Math.random });
  expect(second).not.toBeNull();
  const open = await db.select().from(boosterKitChallenges).where(isNull(boosterKitChallenges.closedAt));
  expect(open).toHaveLength(1);
});
```

Run: `pnpm --filter bot test -- kit-placement`
Expected: PASS.

- [ ] **Step 7: Schedule the tick and commit**

Register `kitPlacementTick` next to the existing verification tick, at the same interval.

```bash
git add apps/bot/src/kit-placement-tick.ts apps/bot/src/kit-placement-issue.ts apps/bot/test/kit-placement-tick.test.ts
git commit -m "feat(bot): witness the booster kit placement emote and capture the spot"
```

---

### Task 6: The generator

**Files:**
- Create: `apps/ingest-worker/src/booster-kits.ts`
- Test: `apps/ingest-worker/test/booster-kits.test.ts`

**Interfaces:**
- Consumes: `SpawnObject` from `./supplies.js`, `armbandFor` from `@factions/domain`
- Produces: `type BoosterKit = { discordId: string; gamertag: string; texture: string | null; x: number; y: number; z: number; items: string[] }`, `generateBoosterKits(kits: BoosterKit[]): string`

- [ ] **Step 1: Write the failing tests**

```ts
// apps/ingest-worker/test/booster-kits.test.ts
import { describe, expect, it } from "vitest";
import { generateBoosterKits } from "../src/booster-kits.js";

// x, y, z in database/spawner order: y is ALTITUDE.
const kit = {
  discordId: "1", gamertag: "Bob", texture: "Flag_Wolf",
  x: 5572.7, y: 312.8, z: 8811.8,
  items: ["GasMask", "GorkaEJacket_Summer"],
};

describe("generateBoosterKits", () => {
  it("emits every item plus the derived armband at the identical position", () => {
    const out = JSON.parse(generateBoosterKits([kit]));
    expect(out.Objects.map((o: any) => o.name)).toEqual(["GasMask", "GorkaEJacket_Summer", "Armband_Wolf"]);
    for (const o of out.Objects) expect(o.pos).toEqual([5572.7, 312.8, 8811.8]);
  });

  it("writes the stored columns out unswapped", () => {
    const out = JSON.parse(generateBoosterKits([kit]));
    expect(out.Objects[0].pos).toEqual([kit.x, kit.y, kit.z]);
  });

  it("emits no armband for a booster in no faction", () => {
    const out = JSON.parse(generateBoosterKits([{ ...kit, texture: null }]));
    expect(out.Objects.map((o: any) => o.name)).toEqual(["GasMask", "GorkaEJacket_Summer"]);
  });

  it("tags each object with the owner so an operator can trace a stray item", () => {
    const out = JSON.parse(generateBoosterKits([kit]));
    for (const o of out.Objects) expect(o.customString).toBe("Bob");
  });

  it("spawns nothing persistent", () => {
    const out = JSON.parse(generateBoosterKits([kit]));
    for (const o of out.Objects) expect(o.enableCEPersistency).toBe(0);
  });

  it("is byte-stable across runs with the same input", () => {
    expect(generateBoosterKits([kit])).toBe(generateBoosterKits([kit]));
  });

  it("emits an empty file for no kits", () => {
    expect(generateBoosterKits([])).toBe(`{"Objects":[]}`);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter ingest-worker test -- booster-kits`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement**

```ts
// apps/ingest-worker/src/booster-kits.ts
import { armbandFor } from "@factions/domain";

/**
 * One booster's kit, already filtered for eligibility by the tick.
 *
 * `texture` is the clan's flag, or null for a booster in no faction, which is
 * what decides whether an armband is emitted. It is NOT stored on the kit row
 * — it is joined live, so a clan change corrects itself at the next restart.
 *
 * Coordinates are in DATABASE/SPAWNER order: x, altitude, z — the same
 * convention as `declarations`. The ADM-order conversion already happened at
 * capture (Task 5), so nothing is swapped here.
 */
export type BoosterKit = {
  discordId: string;
  gamertag: string;
  texture: string | null;
  x: number; y: number; z: number;
  items: string[];
};

/**
 * The exact bytes of the booster kit spawner file.
 *
 * Returns a string rather than an object because the upload tick hashes what
 * it uploads; hashing a re-serialised object could differ from the bytes sent.
 *
 * Unlike the supplies file there is no template and no offsets: all eight
 * items spawn at one point, so this builds objects from scratch.
 */
export function generateBoosterKits(kits: BoosterKit[]): string {
  const out: string[] = [];
  for (const k of kits) {
    const names = [...k.items];
    // ⚠️ Derived, never stored. armbandFor maps Flag_X to Armband_X and all 34
    // flags have an exact match; a booster in no faction simply gets seven.
    if (k.texture) names.push(armbandFor(k.texture));
    for (const name of names) {
      out.push(
        `{"name":${JSON.stringify(name)},` +
        // Already in spawner order; see the note on BoosterKit.
        `"pos":[${k.x},${k.y},${k.z}],` +
        `"ypr":[0,0,0],` +
        `"scale":1,` +
        `"enableCEPersistency":0,` +
        // Ownership, so an operator can tell whose jacket a stray item is.
        `"customString":${JSON.stringify(k.gamertag)}}`,
      );
    }
  }
  return `{"Objects":[${out.join(",")}]}`;
}
```

- [ ] **Step 4: Run to verify pass**

Run: `pnpm --filter ingest-worker test -- booster-kits`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/ingest-worker/src/booster-kits.ts apps/ingest-worker/test/booster-kits.test.ts
git commit -m "feat(ingest-worker): generate the booster kit spawner file"
```

---

### Task 7: The projection tick and sweep wiring

**Files:**
- Create: `apps/ingest-worker/src/booster-kit-tick.ts`
- Modify: `apps/ingest-worker/src/projection-upload.ts` (add `BOOSTER_KIT_STORE`)
- Modify: `apps/ingest-worker/src/sweep.ts:133-175` (register alongside supplies and travel)
- Test: `apps/ingest-worker/test/booster-kit-tick.test.ts`

**Interfaces:**
- Consumes: `syncProjection`, `ProjectionUploader`, `generateBoosterKits`, `BoosterKit`
- Produces: `boosterKitTick(db, deps): Promise<{ kits: number; uploaded: boolean }>`, `BOOSTER_KIT_STORE`

- [ ] **Step 1: Add the upload store**

In `projection-upload.ts`, extend the `storeFor` parameter type and add the export. The three tables have identical columns, which is why one helper serves them.

```ts
const storeFor = (table: typeof supplyUploads | typeof travelUploads | typeof boosterKitUploads): UploadStore => ({ /* unchanged */ });
export const BOOSTER_KIT_STORE: UploadStore = storeFor(boosterKitUploads);
```

- [ ] **Step 2: Write the failing tests**

```ts
// apps/ingest-worker/test/booster-kit-tick.test.ts
describe("boosterKitTick", () => {
  it("includes a booster who is boosting, linked, placed and has an item", async () => {
    const db = await testDb();
    await seedEligibleBooster(db, { discordId: "1", gamertag: "Bob", pos: [1, 2, 3], mask: "GasMask" });
    const client = fakeUploader();
    const r = await boosterKitTick(db, { serverId: 1, client, remoteDir: "/custom", fileName: "booster-kits.json", now: new Date() });
    expect(r.kits).toBe(1);
    expect(client.uploaded).toHaveLength(1);
  });

  it("excludes a booster who stopped boosting", async () => {
    const db = await testDb();
    await seedEligibleBooster(db, { discordId: "1", gamertag: "Bob", pos: [1, 2, 3], mask: "GasMask" });
    await db.delete(discordBoosters).where(eq(discordBoosters.discordId, "1"));
    const client = fakeUploader();
    const r = await boosterKitTick(db, { serverId: 1, client, remoteDir: "/custom", fileName: "booster-kits.json", now: new Date() });
    expect(r.kits).toBe(0);
    expect(client.uploaded[0]!.content).toBe(`{"Objects":[]}`);
  });

  it("excludes a booster who unlinked their character", async () => {
    const db = await testDb();
    await seedEligibleBooster(db, { discordId: "1", gamertag: "Bob", pos: [1, 2, 3], mask: "GasMask" });
    await db.delete(identityLinks).where(eq(identityLinks.discordId, "1"));
    const client = fakeUploader();
    const r = await boosterKitTick(db, { serverId: 1, client, remoteDir: "/custom", fileName: "booster-kits.json", now: new Date() });
    expect(r.kits).toBe(0);
    expect(client.uploaded[0]!.content).toBe(`{"Objects":[]}`);
  });

  it("excludes a kit that was configured but never placed", async () => {
    const db = await testDb();
    await seedEligibleBooster(db, { discordId: "1", gamertag: "Bob", pos: null, mask: "GasMask" });
    const client = fakeUploader();
    const r = await boosterKitTick(db, { serverId: 1, client, remoteDir: "/custom", fileName: "booster-kits.json", now: new Date() });
    expect(r.kits).toBe(0);
    expect(client.uploaded[0]!.content).toBe(`{"Objects":[]}`);
  });

  it("excludes a kit with every slot empty", async () => {
    const db = await testDb();
    await seedEligibleBooster(db, { discordId: "1", gamertag: "Bob", pos: [1, 2, 3] });
    const client = fakeUploader();
    const r = await boosterKitTick(db, { serverId: 1, client, remoteDir: "/custom", fileName: "booster-kits.json", now: new Date() });
    expect(r.kits).toBe(0);
    expect(client.uploaded[0]!.content).toBe(`{"Objects":[]}`);
  });

  it("skips a class name that has left the catalogue and still spawns the rest", async () => {
    const db = await testDb();
    await seedEligibleBooster(db, { discordId: "1", gamertag: "Bob", pos: [1, 2, 3], mask: "NotInCatalogue", jacket: "GorkaEJacket_Summer" });
    const client = fakeUploader();
    await boosterKitTick(db, { serverId: 1, client, remoteDir: "/custom", fileName: "booster-kits.json", now: new Date() });
    const names = JSON.parse(client.uploaded[0]!.content).Objects.map((o: any) => o.name);
    expect(names).not.toContain("NotInCatalogue");
    expect(names).toContain("GorkaEJacket_Summer");
  });

  it("does not re-upload when nothing changed", async () => {
    const db = await testDb();
    await seedEligibleBooster(db, { discordId: "1", gamertag: "Bob", pos: [1, 2, 3], mask: "GasMask" });
    const client = fakeUploader();
    const deps = { serverId: 1, client, remoteDir: "/custom", fileName: "booster-kits.json", now: new Date() };
    await boosterKitTick(db, deps);
    const second = await boosterKitTick(db, deps);
    expect(second.uploaded).toBe(false);
  });

  it("retries after a failed upload", async () => {
    const db = await testDb();
    await seedEligibleBooster(db, { discordId: "1", gamertag: "Bob", pos: [1, 2, 3], mask: "GasMask" });
    const failing = { ...fakeUploader(), uploadFile: async () => { throw new Error("nitrado down"); } };
    const deps = { serverId: 1, remoteDir: "/custom", fileName: "booster-kits.json", now: new Date() };
    await expect(boosterKitTick(db, { ...deps, client: failing })).rejects.toThrow();
    const ok = fakeUploader();
    expect((await boosterKitTick(db, { ...deps, client: ok })).uploaded).toBe(true);
  });
});
```

Two helpers these tests need, defined at the top of the file:

```ts
/** Records what was sent instead of talking to Nitrado. statFile returns null,
 *  which is the "no baseline yet" path syncProjection already handles. */
function fakeUploader() {
  const uploaded: { remoteDir: string; fileName: string; content: string }[] = [];
  return {
    uploaded,
    uploadFile: async (remoteDir: string, fileName: string, content: string) => {
      uploaded.push({ remoteDir, fileName, content });
    },
    statFile: async () => null,
  };
}

/** One booster who satisfies every eligibility condition, so each test can
 *  remove exactly one of them and assert the kit disappears. */
async function seedEligibleBooster(db: Database, a: {
  discordId: string; gamertag: string; pos: [number, number, number] | null;
  mask?: string; jacket?: string;
}) {
  const now = new Date();
  await db.insert(discordBoosters).values({ discordId: a.discordId, premiumSince: now, observedAt: now });
  await db.insert(identityLinks).values({
    discordId: a.discordId, dayzId: "A".repeat(40), gamertag: a.gamertag, verifiedAt: now,
  });
  await db.insert(boosterKits).values({
    discordId: a.discordId,
    posX: a.pos?.[0] ?? null, posY: a.pos?.[1] ?? null, posZ: a.pos?.[2] ?? null,
    mask: a.mask ?? null, jacket: a.jacket ?? null,
  });
}
```

- [ ] **Step 3: Run to verify failure**

Run: `pnpm --filter ingest-worker test -- booster-kit-tick`
Expected: FAIL, module not found.

- [ ] **Step 4: Implement**

The query inner-joins `booster_kits` to `discord_boosters` and `identity_links` on `discord_id`, and left-joins the faction that the character belongs to for its texture. Order by `discord_id` for stable bytes. Convert every coordinate with `Number()`. Build `items` by reading the nine slot columns in `KIT_SLOTS` order, dropping nulls and anything `isAllowed` rejects.

```ts
const list: BoosterKit[] = rows
  .map((r) => ({
    discordId: r.discordId,
    gamertag: r.gamertag,
    texture: r.texture,
    x: Number(r.posX), y: Number(r.posY), z: Number(r.posZ),
    items: KIT_SLOTS
      .map((slot) => ({ slot, className: r[slot] }))
      .filter((s): s is { slot: KitSlot; className: string } => s.className !== null)
      .filter((s) => isAllowed(catalogue, s.slot, s.className))
      .map((s) => s.className),
  }))
  // ⚠️ After catalogue filtering, not before: a kit whose only slot holds a
  // class name that has since left the catalogue has nothing to spawn.
  .filter((k) => k.items.length > 0);

const content = generateBoosterKits(list);
const uploaded = await syncProjection(db, { /* ... */ store: BOOSTER_KIT_STORE });
return { kits: list.length, uploaded };
```

- [ ] **Step 5: Run to verify pass**

Run: `pnpm --filter ingest-worker test -- booster-kit-tick`
Expected: PASS.

- [ ] **Step 6: Register in the sweep**

In `sweep.ts`, alongside the supplies and travel projections, using `await client.missionCustomDir()` for `remoteDir` and `"booster-kits.json"` for `fileName`. Follow the existing per-server try/catch and the `onDrift` reporting the neighbours use, so a booster kit failure cannot take down the supplies projection.

- [ ] **Step 7: Run the whole worker suite and commit**

Run: `pnpm --filter ingest-worker test`

```bash
git add apps/ingest-worker/src/booster-kit-tick.ts apps/ingest-worker/src/projection-upload.ts apps/ingest-worker/src/sweep.ts apps/ingest-worker/test/booster-kit-tick.test.ts
git commit -m "feat(ingest-worker): project booster kits onto the server"
```

---

### Task 8: The web picker

**Files:**
- Create: `apps/web/app/(site)/kit/page.tsx`
- Create: `apps/web/app/(site)/kit/actions.ts`
- Modify: `apps/web/app/(site)/menu-list.tsx` (add the entry)
- Test: `apps/web/test/kit.test.ts`

**Read first:** `apps/web/AGENTS.md`. It warns that this Next.js version differs from training data and that the relevant guide under `node_modules/next/dist/docs/` must be read before writing any code.

**Interfaces:**
- Consumes: `loadCatalogue`, `isAllowed`, `KIT_SLOTS` from Task 2; `issuePlacementChallenge` from Task 5; `boosterKits` from Task 3
- Produces: `saveKit(formData)` and `startPlacement()` server actions

- [ ] **Step 1: Write the failing tests for the actions**

Test the action logic, not the rendering:

```ts
describe("saveKit", () => {
  it("rejects a class name outside the catalogue for that slot", async () => {
    await expect(saveKit({ discordId: "1", slot: "mask", className: "GorkaEJacket_Summer" })).rejects.toThrow();
  });

  it("accepts an allowed class name and leaves the position untouched", async () => {
    const db = await testDb();
    await db.insert(boosterKits).values({ discordId: "1", posX: 1, posY: 2, posZ: 3 });
    await saveKit({ discordId: "1", slot: "mask", className: "GasMask" });
    const [row] = await db.select().from(boosterKits);
    expect(row!.mask).toBe("GasMask");
    expect(Number(row!.posX)).toBe(1);
  });

  it("clears a slot when given an empty class name", async () => {
    await saveKit({ discordId: "1", slot: "mask", className: "" });
    const [row] = await db.select().from(boosterKits);
    expect(row!.mask).toBeNull();
  });
});
```

The second test is the one that encodes the spec's §2.6: editing gear must never disturb the spot.

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter web test -- kit`
Expected: FAIL.

- [ ] **Step 3: Implement the actions**

`saveKit` upserts one slot column after checking `isAllowed`, and never writes position. `startPlacement` calls `issuePlacementChallenge` and returns the sequence to display.

- [ ] **Step 4: Implement the page**

Three states, following the existing pages' shape:

1. Not boosting: explain the perk is for server boosters and how to boost. Do not gate the page behind boosting; someone deciding whether to boost should be able to see what they would get.
2. Boosting, not linked: point at the existing link flow.
3. Boosting and linked: nine dropdowns from the catalogue, the derived armband shown read-only with the clan's flag, the current spot if any, and a button that draws the placement emotes.

Copy rules: plain voice, no em dashes, and nothing that frames the kit as protected. Say plainly that the kit is on the ground and anyone who finds it can take it, and that it comes back at the next restart.

- [ ] **Step 5: Run the suite**

Run: `pnpm --filter web test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/web/app/\(site\)/kit apps/web/app/\(site\)/menu-list.tsx apps/web/test/kit.test.ts
git commit -m "feat(web): booster kit picker and placement flow"
```

---

### Task 9: Deploy notes and changelog

**Files:**
- Create: `docs/deploy/2026-09-19-booster-kits.md`
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Write the deploy note**

It must state, in order:

1. Apply the migration from Task 3.
2. Deploy the bot and the ingest worker.
3. Confirm `booster-kits.json` appears in the mission's `custom` directory after one sweep. It will contain `{"Objects":[]}` until a booster places a kit, which is correct.
4. **The manual step:** add `./custom/booster-kits.json` to `WorldsData.objectSpawnersArr` in `cfggameplay.json`, next to the supplies file. Change nothing else in that file. `docs/deploy/raid-window.md` carries the same warning.
5. Restart, and confirm a placed kit appears.

Record the rollback: remove the entry from `objectSpawnersArr`. Until step 4 is done the worker is uploading a file the server ignores, so steps 1 to 3 are safe to deploy and safe to leave.

- [ ] **Step 2: Roll the changelog**

`.keel.json` sets `requireChangelog: true`, so the PR gate needs this. Follow the existing entry style.

- [ ] **Step 3: Commit**

```bash
git add docs/deploy/2026-09-19-booster-kits.md CHANGELOG.md
git commit -m "docs(booster-kits): deploy notes and changelog"
```

---

## Catalogue sourcing

Task 2's `booster-catalogue.json` contents are decided in a separate session before that task runs. The method, which resolves the wiki-name to class-name mismatch:

1. **Start from the server, not the wiki.** Pull the live `types.xml` with `NitradoClient.missionDbDir()` and `downloadFile()`. Those class names are authoritative for this server and definitionally spawnable, which removes the guessing entirely.
2. **Narrow by category.** `types.xml` entries carry `<category name="clothes"/>`, which cuts the list to clothing without any name heuristics.
3. **Group by slot.** Class name prefixes and suffixes sort most of the remainder into the seven slots.
4. **Then reach for the wiki** only to attach a display label and an image to a class name already chosen, rather than trying to map a wiki page back to a class name.

Images are an open question for the picker: the wiki's are not ours to hotlink. Options are capturing our own, or shipping the picker with labels only at first.
