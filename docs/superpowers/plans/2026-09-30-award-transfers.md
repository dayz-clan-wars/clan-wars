# Award Transfers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an award's owner give it to another linked player from `/awards/<id>`, pausing a placed or live award's clock until the new owner's placement spawns.

**Architecture:** A transfer is one roster transaction that rewrites the grant's owner, clears its spot and clock into a new `remaining_ms`, resets `place_by`, closes any open placement sequence, appends an `award_transfers` history row and two DM notices. The worker starts the clock from `remaining_ms` when present. The award page gets a give flow over the existing linked-gamertag autocomplete.

**Tech Stack:** TypeScript, pnpm + turbo, vitest, drizzle-orm (Postgres, migrations via drizzle-kit), Next.js (apps/web), discord.js (apps/bot).

**Spec:** `docs/superpowers/specs/2026-09-30-award-transfers-design.md`

## Global Constraints

- Transferable states: `unplaced`, `waiting`, `live` (`isOpenAward`). Recipient: any linked player other than the owner.
- Every transfer sets `place_by = now + AWARD_PLACE_BY_MS` and `remaining_ms = awardTimeLeftMs(grant, now)`, and clears `pos_x/y/z`, `placed_at`, `live_from`, `expires_at`.
- Lock order inside the transfer: `award_grants` (FOR UPDATE) → `booster_kit_challenges` → `award_transfers` → `clan_notices`.
- Site only. `giveAward` goes in `parity.test.ts`'s `PENDING` as `"awards give"`.
- Player-facing copy: no em dashes, plain voice.
- Test gate: `TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions"` for DB suites; never two suites at once.
- Feature branch `feature/award-transfers` (already created, spec committed). Commits end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

- **Transfer racing the winner's last emote.** The placement tick takes `award_grants` then the challenge; the transfer must take them in the same order, so it cannot deadlock. Pinned in Task 3 by the order of statements. The reviewer should check it against `kit-placement-tick.ts`.
- **A live award with under a minute left.** Expected: `remaining_ms` is small but never negative, and the new owner gets that sliver. Pinned in Task 1 (`max(0, …)`).
- **Old owner's open tab.** After a transfer, the old owner's award page polls `/status` and pressing Place both answer not-found, never acting on the new owner's grant. Pinned in Task 3 (old owner refused on pick) and by `awardForDb`'s owner WHERE.
- **Recipient typed with different capitalisation.** Expected: resolved like invites do (`resolveGamertagLink`, exact first then case-insensitive), and refused as ambiguous when two linked players match. Pinned in Task 3.
- **A second transfer before the award is placed again.** Expected: `remaining_ms` carries over unchanged, not reset to `duration_days`. Pinned in Tasks 1 and 3.

---

### Task 1: Time left and the clock, in the domain

**Files:**
- Modify: `packages/domain/src/awards.ts` (after `awardClock`, around line 125)
- Test: `packages/domain/test/awards.test.ts`

**Interfaces:**
- Produces:
  - `awardTimeLeftMs(g: { liveFrom: Date | null; expiresAt: Date | null; remainingMs: number | null; durationDays: number }, now: Date): number`
  - `awardClockMs(uploadedAt: Date, lengthMs: number): { liveFrom: Date; expiresAt: Date }` (`awardClock` becomes a wrapper)
  - `timeLeftText(ms: number): string`

- [ ] **Step 1: Write the failing tests**

Add `awardTimeLeftMs, awardClockMs, timeLeftText` to the import from `"../src/awards"` in `packages/domain/test/awards.test.ts`, then append:

```ts
describe("awardTimeLeftMs", () => {
  const H = 3_600_000; const D = 24 * H;
  const at = new Date("2026-09-30T12:00:00Z");
  const g = (o: Partial<{ liveFrom: Date | null; expiresAt: Date | null; remainingMs: number | null; durationDays: number }>) =>
    ({ liveFrom: null, expiresAt: null, remainingMs: null, durationDays: 3, ...o });

  it("is the full length before any clock or transfer", () => {
    expect(awardTimeLeftMs(g({}), at)).toBe(3 * D);
  });
  it("is a previous transfer's time left, unchanged, until the clock starts again", () => {
    expect(awardTimeLeftMs(g({ remainingMs: 5 * H }), at)).toBe(5 * H);
  });
  it("is the whole length when stamped but not live yet", () => {
    const liveFrom = new Date(at.getTime() + H);
    expect(awardTimeLeftMs(g({ liveFrom, expiresAt: new Date(liveFrom.getTime() + 3 * D) }), at)).toBe(3 * D);
  });
  it("counts down from now once live", () => {
    expect(awardTimeLeftMs(g({ liveFrom: new Date(at.getTime() - D), expiresAt: new Date(at.getTime() + 2 * D) }), at)).toBe(2 * D);
  });
  it("⚠️ never goes below zero", () => {
    expect(awardTimeLeftMs(g({ liveFrom: new Date(at.getTime() - D), expiresAt: new Date(at.getTime() - 1) }), at)).toBe(0);
  });
});

describe("awardClockMs", () => {
  it("runs a given length from the next restart, and awardClock is its day form", () => {
    const up = new Date("2026-09-30T13:10:00Z");
    const c = awardClockMs(up, 5 * 3_600_000);
    expect(c.liveFrom.toISOString()).toBe("2026-09-30T14:00:00.000Z");
    expect(c.expiresAt.getTime() - c.liveFrom.getTime()).toBe(5 * 3_600_000);
    expect(awardClock(up, 2)).toEqual(awardClockMs(up, 2 * 86_400_000));
  });
});

describe("timeLeftText", () => {
  it.each([
    [2 * 86_400_000 + 5 * 3_600_000, "2 days 5 hours"],
    [86_400_000, "1 day"],
    [3 * 86_400_000 + 3_600_000, "3 days 1 hour"],
    [5 * 3_600_000 + 59 * 60_000, "5 hours"],
    [59 * 60_000, "less than an hour"],
    [0, "less than an hour"],
  ])("%d ms reads %s", (ms, text) => {
    expect(timeLeftText(ms)).toBe(text);
  });
});
```

If `awardClock` is not already imported in this test file, add it to the same import.

- [ ] **Step 2: Run to see them fail**

Run: `pnpm --filter @factions/domain test -- awards`
Expected: FAIL (the three functions are not exported).

- [ ] **Step 3: Implement**

In `packages/domain/src/awards.ts`, add `const HOUR_MS = 3_600_000;` beside `DAY_MS`, replace `awardClock`'s body, and add the two new functions after it:

```ts
export function awardClock(uploadedAt: Date, durationDays: number): { liveFrom: Date; expiresAt: Date } {
  return awardClockMs(uploadedAt, durationDays * DAY_MS);
}

/**
 * `awardClock` for a length in milliseconds: a transferred award resumes with
 * the time it had left, which is rarely a whole number of days.
 */
export function awardClockMs(uploadedAt: Date, lengthMs: number): { liveFrom: Date; expiresAt: Date } {
  const liveFrom = nextRestartAt(uploadedAt);
  return { liveFrom, expiresAt: new Date(liveFrom.getTime() + lengthMs) };
}

/**
 * How long an award has left to run (transfers spec §3): what a transfer
 * saves into `remaining_ms`, and what the worker's stamp runs for.
 *
 * ⚠️ Once stamped, counted from `max(now, live_from)`: time before it went
 * live was never spent. ⚠️ Never negative, so an award given away in its last
 * minute hands over a sliver, not a clock that ends before it starts.
 */
export function awardTimeLeftMs(
  g: { liveFrom: Date | null; expiresAt: Date | null; remainingMs: number | null; durationDays: number }, now: Date,
): number {
  if (g.expiresAt) {
    const from = Math.max(now.getTime(), g.liveFrom?.getTime() ?? now.getTime());
    return Math.max(0, g.expiresAt.getTime() - from);
  }
  return g.remainingMs ?? g.durationDays * DAY_MS;
}

/** "2 days 5 hours", "1 day", "5 hours", "less than an hour": whole hours, rounded down. */
export function timeLeftText(ms: number): string {
  const hours = Math.floor(ms / HOUR_MS);
  if (hours < 1) return "less than an hour";
  const d = Math.floor(hours / 24);
  const h = hours % 24;
  const part = (n: number, unit: string) => `${n} ${unit}${n === 1 ? "" : "s"}`;
  return [d > 0 ? part(d, "day") : "", h > 0 ? part(h, "hour") : ""].filter(Boolean).join(" ");
}
```

- [ ] **Step 4: Run to see them pass**

Run: `pnpm --filter @factions/domain test -- awards` → PASS. Then `pnpm --filter @factions/domain typecheck`.

- [ ] **Step 5: Commit**

```bash
git add packages/domain/src/awards.ts packages/domain/test/awards.test.ts
git commit -m "feat(awards): time left on an award, and a clock of any length

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: The two new DMs

**Files:**
- Modify: `packages/domain/src/feed.ts:33` (`CLAN_NOTICE_KINDS`)
- Modify: `apps/bot/src/notice-text.ts` (renderers after `award_granted`, line ~238; `LINK_BUTTONS`, line ~291)
- Modify: `apps/web/lib/notice-copy.ts` (after `award_granted`, line ~283)
- Test: `apps/bot/test/award-notice.test.ts`, `apps/web/test/notice-copy.test.ts`

**Interfaces:**
- Consumes: `timeLeftText` (Task 1).
- Produces: notice kinds `award_received` with payload `{ grantId: number; awardKey: string; label: string; fromName: string; placeBy: string (ISO); remainingMs: number; awardUrl: string }`, and `award_given` with payload `{ grantId: number; awardKey: string; label: string; toName: string }`.

- [ ] **Step 1: Write the failing tests**

Append to `apps/bot/test/award-notice.test.ts`:

```ts
describe("award_received and award_given", () => {
  const received = {
    kind: "award_received" as const, target: "dm" as const, occurredAt: new Date("2026-09-30T12:00:00Z"),
    payload: {
      grantId: 12, awardKey: "weapon-kit", label: "Weapon Kit", fromName: "Ron",
      placeBy: "2026-10-07T12:00:00.000Z", remainingMs: 2 * 86_400_000 + 5 * 3_600_000,
      awardUrl: "https://dayzclanwars.com/awards/12",
    },
  };

  it("names the giver, the award, the deadline and the time left", () => {
    const t = noticeText(received, "https://dayzclanwars.com", 1);
    expect(t).toContain("Ron gave you **Weapon Kit**");
    expect(t).toContain("<t:1791374400:F>");
    expect(t).toContain("It has 2 days 5 hours left, and the clock starts once it spawns.");
    expect(t).not.toMatch(/—|NaN|undefined/u);
  });

  it("links to the award page", () => {
    expect(JSON.stringify(noticeComponents(received))).toContain("https://dayzclanwars.com/awards/12");
  });

  it("gives the receipt to the giver", () => {
    const t = noticeText({ ...received, kind: "award_given", payload: { grantId: 12, awardKey: "weapon-kit", label: "Weapon Kit", toName: "Ann" } }, "https://x", 1);
    expect(t).toBe("You gave your **Weapon Kit** to Ann.");
  });
});
```

In `apps/web/test/notice-copy.test.ts`, add inside the `describe` that holds the `award_granted` cases:

```ts
  it("award_received names the giver and the time left, and links to the award", () => {
    const c = noticeCopy("award_received", { grantId: 12, label: "Weapon Kit", fromName: "Ron", placeBy: "2026-10-07T12:00:00.000Z", remainingMs: 5 * 3_600_000 }, "dm");
    expect(c.title).toBe("Ron gave you Weapon Kit");
    expect(c.body).toContain("It has 5 hours left, and the clock starts once it spawns.");
    expect(c.cta).toEqual({ label: "Configure your award", href: "/awards/12" });
  });

  it("award_given says who has it now", () => {
    const c = noticeCopy("award_given", { grantId: 12, label: "Weapon Kit", toName: "Ann" }, "dm");
    expect(c.title).toBe("You gave away Weapon Kit");
    expect(c.body).toBe("It belongs to Ann now.");
  });
```

- [ ] **Step 2: Run to see them fail**

Run: `pnpm --filter @factions/bot test -- award-notice notice-text` and `pnpm --filter @factions/web test -- notice-copy`
Expected: FAIL (unknown kinds, and a type error in the test for the kind literal is acceptable here).

- [ ] **Step 3: Implement**

`packages/domain/src/feed.ts`: add `"award_received", "award_given",` after `"award_granted",` in `CLAN_NOTICE_KINDS`.

`apps/bot/src/notice-text.ts`: add `timeLeftText` to its `@factions/domain` import, then after the `award_granted` renderer:

```ts
  award_received: (p) => {
    // ⚠️ The deadline clause is dropped on an unparseable date, as award_granted's is.
    const by = atToken(p.placeBy);
    const left = typeof p.remainingMs === "number"
      ? ` It has ${timeLeftText(p.remainingMs)} left, and the clock starts once it spawns.` : "";
    return `🎁 ${p.fromName ? String(p.fromName) : "Another player"} gave you **${p.label ? String(p.label) : "an award"}**. `
      + `Choose your gear and mark where it spawns${by ? ` by ${by}` : ""}.${left}`;
  },
  award_given: (p) => `You gave your **${p.label ? String(p.label) : "award"}** to ${p.toName ? String(p.toName) : "another player"}.`,
```

and in `LINK_BUTTONS`: `award_received: { label: "Configure your award", field: "awardUrl" },`.

`apps/web/lib/notice-copy.ts`: add `timeLeftText` to its `@factions/domain` import (add the import if the file has none), then after `award_granted`:

```ts
  award_received: { group: "Roster", render: (p) => ({
    kicker: "Award",
    title: `${p.fromName ? String(p.fromName) : "Another player"} gave you ${p.label ? String(p.label) : "an award"}`,
    body: `Choose your gear and mark where it spawns${dateOf(p.placeBy) ? ` by ${dateOf(p.placeBy)}` : ""}.`
      + (typeof p.remainingMs === "number" ? ` It has ${timeLeftText(p.remainingMs)} left, and the clock starts once it spawns.` : ""),
    // ⚠️ The grant id, never the payload's URL: see award_granted.
    cta: { label: "Configure your award", href: typeof p.grantId === "number" ? `/awards/${p.grantId}` : "/awards" },
  }) },
  award_given: { group: "Roster", render: (p) => ({
    kicker: "Award",
    title: `You gave away ${p.label ? String(p.label) : "an award"}`,
    body: `It belongs to ${p.toName ? String(p.toName) : "another player"} now.`,
  }) },
```

- [ ] **Step 4: Run to see them pass**

Run: `pnpm --filter @factions/bot test -- award-notice notice-text` and `pnpm --filter @factions/web test -- notice-copy` → PASS (the kind-coverage tests too). Then `pnpm --filter @factions/domain typecheck`, `pnpm --filter @factions/bot typecheck`, `pnpm --filter @factions/web typecheck`.

- [ ] **Step 5: Commit**

```bash
git add packages/domain/src/feed.ts apps/bot/src/notice-text.ts apps/web/lib/notice-copy.ts apps/bot/test/award-notice.test.ts apps/web/test/notice-copy.test.ts
git commit -m "feat(awards): DMs for a received and a given award

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: The transfer write

**Files:**
- Modify: `packages/db/src/schema.ts` (`awardGrants`, line ~1418; new `awardTransfers` right after it)
- Create: `packages/db/migrations/0060_*.sql` (generated) and its `meta/` snapshot
- Modify: `packages/roster/src/awards.ts` (`AwardSummary`, `summary`, new `giveAwardDb`)
- Modify: `packages/roster/src/api.ts` (wrapper and type exports), `packages/roster/src/index.ts`
- Modify: `packages/roster/test/roster-exports.ts`, `apps/web/test/smoke.test.ts`, `apps/bot/test/parity.test.ts`
- Test: `packages/roster/test/award-transfer.test.ts` (create)

**Interfaces:**
- Consumes: `awardTimeLeftMs` (Task 1); notice kinds and payloads (Task 2).
- Produces:
  - `awardGrants.remainingMs: number | null`; table `awardTransfers { id, awardGrantId, fromDiscordId, toDiscordId, transferredAt, remainingMs }`
  - `AwardSummary.remainingMs: number | null`
  - `type GiveAwardOutcome = { ok: true; toGamertag: string } | { ok: false; reason: "not-found" | "ended" | "recipient-not-linked" | "recipient-is-you" | "ambiguous-gamertag" | "no-server" }`
  - `giveAwardDb(db, { discordId: string; grantId: number; toGamertag: string; siteBaseUrl: string; now: Date }): Promise<GiveAwardOutcome>`
  - roster export `giveAward(discordId: string, grantId: number, toGamertag: string): Promise<GiveAwardOutcome>`

- [ ] **Step 1: Schema and migration**

In `packages/db/src/schema.ts`, in `awardGrants` after `expiresAt`:

```ts
  /**
   * The time left when the award was last given away (transfers spec §3).
   * Null means never transferred: the worker then runs it for `duration_days`.
   * ⚠️ Written only by a transfer, read only by the worker's stamp.
   */
  remainingMs: bigint("remaining_ms", { mode: "number" }),
```

Right after the `awardGrants` table:

```ts
/**
 * One row per award transfer (transfers spec §4). Insert-only history, read
 * only by `/award list`; nothing decides anything from it.
 */
export const awardTransfers = pgTable("award_transfers", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  awardGrantId: bigint("award_grant_id", { mode: "number" }).notNull().references(() => awardGrants.id),
  fromDiscordId: text("from_discord_id").notNull(),
  toDiscordId: text("to_discord_id").notNull(),
  transferredAt: timestamp("transferred_at", { withTimezone: true }).notNull(),
  remainingMs: bigint("remaining_ms", { mode: "number" }).notNull(),
}, (t) => ({
  byGrant: index("award_transfers_grant_idx").on(t.awardGrantId),
}));
```

Run: `cd packages/db && npx drizzle-kit generate`. Read the new `0060_*.sql`: it must only `ALTER TABLE "award_grants" ADD COLUMN "remaining_ms" bigint`, `CREATE TABLE "award_transfers"`, its FK and its index. Nothing else.

- [ ] **Step 2: Write the failing tests**

Create `packages/roster/test/award-transfer.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import {
  createClient, runMigrations, requireTestDatabaseUrl,
  servers, awardGrants, awardTransfers, boosterKitChallenges, clanNotices, identityLinks, type Database,
} from "@factions/db";
import { sql, eq } from "drizzle-orm";
import { giveAwardDb, saveAwardPickDb, awardForDb } from "../src/awards";

const URL = requireTestDatabaseUrl();
const now = new Date("2026-09-30T12:00:00Z");
const H = 3_600_000; const D = 24 * H;
const WEEK = 7 * D;

describe("giving an award away", () => {
  let db: Database; let grantId = 0;

  beforeEach(async () => {
    db = createClient(URL);
    await runMigrations(db);
    await db.transaction(async (tx) => {
      await tx.execute(sql`set local client_min_messages = warning`);
      await tx.execute(sql`truncate table award_transfers, award_grants, booster_kit_challenges, clan_notices, identity_links, servers restart identity cascade`);
    });
    await db.insert(servers).values({ name: "S", map: "livonia", clockOffsetMs: 0, active: true });
    await db.insert(identityLinks).values([
      { discordId: "1", dayzId: "A".repeat(40), gamertag: "Ron", verifiedAt: now },
      { discordId: "2", dayzId: "B".repeat(40), gamertag: "Ann", verifiedAt: now },
    ]);
    const [g] = await db.insert(awardGrants).values({
      awardKey: "plate-carrier", discordId: "1", grantedByDiscordId: "9", reason: "Won", durationDays: 3,
      grantedAt: now, placeBy: new Date(now.getTime() + WEEK),
      picks: { vest: "PlateCarrierVest_Black", pouches: "PlateCarrierPouches_Green", holster: "PlateCarrierHolster_Camo" },
    }).returning();
    grantId = g!.id;
  });

  const give = (to: string, from = "1", at = now) =>
    giveAwardDb(db, { discordId: from, grantId, toGamertag: to, siteBaseUrl: "https://dayzclanwars.com", now: at });
  const row = async () => (await db.select().from(awardGrants).where(eq(awardGrants.id, grantId)))[0]!;
  const place = () => db.update(awardGrants).set({ posX: "1.00", posY: "2.00", posZ: "3.00", placedAt: now }).where(eq(awardGrants.id, grantId));

  it("moves an unplaced award, with a fresh week and its full length saved", async () => {
    expect(await give("Ann")).toEqual({ ok: true, toGamertag: "Ann" });
    const g = await row();
    expect(g).toMatchObject({ discordId: "2", remainingMs: 3 * D, liveFrom: null, expiresAt: null, placedAt: null });
    expect(g.placeBy.getTime()).toBe(now.getTime() + WEEK);
  });

  it("⚠️ pauses a live award: spot and clock cleared, the time left saved", async () => {
    await place();
    await db.update(awardGrants).set({ liveFrom: new Date(now.getTime() - D), expiresAt: new Date(now.getTime() + 2 * D) }).where(eq(awardGrants.id, grantId));
    await give("Ann");
    expect(await row()).toMatchObject({ discordId: "2", remainingMs: 2 * D, posX: null, posY: null, posZ: null, placedAt: null, liveFrom: null, expiresAt: null });
  });

  it("closes the giver's open placement sequence for it", async () => {
    await db.insert(boosterKitChallenges).values({
      discordId: "1", targetDayzId: "A".repeat(40), sequence: ["EmoteGreeting"], progressIndex: 0,
      issuedAt: now, expiresAt: new Date(now.getTime() + H), awardGrantId: grantId,
    });
    await give("Ann");
    const [c] = await db.select().from(boosterKitChallenges);
    expect(c!.closedAt).toEqual(now);
  });

  it("records the transfer and DMs both players", async () => {
    await give("Ann");
    expect(await db.select().from(awardTransfers)).toEqual([expect.objectContaining({
      awardGrantId: grantId, fromDiscordId: "1", toDiscordId: "2", transferredAt: now, remainingMs: 3 * D,
    })]);
    const notices = await db.select().from(clanNotices).orderBy(clanNotices.id);
    expect(notices.map((n) => [n.kind, n.discordTargetId])).toEqual([["award_received", "2"], ["award_given", "1"]]);
    expect(notices[0]!.payload).toMatchObject({ grantId, label: "Plate Carrier", fromName: "Ron", remainingMs: 3 * D, awardUrl: `https://dayzclanwars.com/awards/${grantId}` });
    expect(notices[1]!.payload).toMatchObject({ grantId, label: "Plate Carrier", toName: "Ann" });
  });

  it("⚠️ a second transfer keeps the saved time, not the full length", async () => {
    await db.update(awardGrants).set({ remainingMs: 5 * H }).where(eq(awardGrants.id, grantId));
    await give("Ann");
    await give("Ron", "2");
    expect(await row()).toMatchObject({ discordId: "1", remainingMs: 5 * H });
  });

  it("hands the page to the new owner and takes it from the old one", async () => {
    await give("Ann");
    expect(await awardForDb(db, "1", grantId, now)).toBeNull();
    expect(await saveAwardPickDb(db, { discordId: "1", grantId, slot: "vest", className: "PlateCarrierVest", now })).toEqual({ ok: false, reason: "not-found" });
    expect(await saveAwardPickDb(db, { discordId: "2", grantId, slot: "vest", className: "PlateCarrierVest", now })).toEqual({ ok: true });
  });

  it("resolves the recipient's gamertag regardless of case", async () => {
    expect(await give("ann")).toEqual({ ok: true, toGamertag: "Ann" });
  });

  it.each([
    ["a grant that is not the giver's", () => giveAwardDb(db, { discordId: "2", grantId, toGamertag: "Ron", siteBaseUrl: "x", now }), "not-found"],
    ["a recipient nobody has linked", () => giveAwardDb(db, { discordId: "1", grantId, toGamertag: "Nobody", siteBaseUrl: "x", now }), "recipient-not-linked"],
    ["an empty recipient", () => giveAwardDb(db, { discordId: "1", grantId, toGamertag: "  ", siteBaseUrl: "x", now }), "recipient-not-linked"],
    ["the giver themselves", () => giveAwardDb(db, { discordId: "1", grantId, toGamertag: "Ron", siteBaseUrl: "x", now }), "recipient-is-you"],
  ])("refuses %s", async (_n, call, reason) => {
    expect(await call()).toEqual({ ok: false, reason });
    expect((await row()).discordId).toBe("1");
    expect(await db.select().from(awardTransfers)).toEqual([]);
  });

  it("refuses an award that has ended", async () => {
    await db.update(awardGrants).set({ revokedAt: now }).where(eq(awardGrants.id, grantId));
    expect(await give("Ann")).toEqual({ ok: false, reason: "ended" });
  });

  it("refuses when two linked players share the name", async () => {
    await db.insert(identityLinks).values({ discordId: "3", dayzId: "C".repeat(40), gamertag: "ANN", verifiedAt: now });
    expect(await give("aNN")).toEqual({ ok: false, reason: "ambiguous-gamertag" });
  });
});
```

- [ ] **Step 3: Run to see them fail**

Run: `TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions" pnpm --filter @factions/roster test -- award-transfer`
Expected: FAIL (`giveAwardDb` is not exported).

- [ ] **Step 4: Implement `giveAwardDb`**

In `packages/roster/src/awards.ts`:
- imports: add `awardTransfers, identityLinks, servers` to the `@factions/db` import; add `AWARD_PLACE_BY_MS, awardTimeLeftMs` to the `@factions/domain` import; add `import { resolveGamertagLink } from "./writes";` and `import { appendClanNoticeTx } from "./internal/notices";`.
- `AwardSummary` gains `remainingMs: number | null;`, and `summary()` sets `remainingMs: g.remainingMs`.

Then append:

```ts
export type GiveAwardOutcome =
  | { ok: true; toGamertag: string }
  | { ok: false; reason: "not-found" | "ended" | "recipient-not-linked" | "recipient-is-you" | "ambiguous-gamertag" | "no-server" };

/**
 * Give an award to another linked player (transfers spec §2, §3).
 *
 * The award restarts its life with the new owner: a fresh week to place it,
 * no spot, and its clock paused into `remaining_ms` until the new spot's
 * first upload stamps it again. Picks carry over.
 *
 * ⚠️ `award_grants` FOR UPDATE, then the challenge: the order revoke and
 * `kitPlacementTick` take them in (CLAUDE.md lock order). The opposite order
 * deadlocks against the giver's last emote.
 * ⚠️ Ownership is in the locking WHERE, so another player's grant and a
 * missing one are the same answer.
 */
export async function giveAwardDb(db: Database, a: {
  discordId: string; grantId: number; toGamertag: string; siteBaseUrl: string; now: Date;
}): Promise<GiveAwardOutcome> {
  const name = a.toGamertag.trim();
  if (!name) return { ok: false, reason: "recipient-not-linked" };
  const to = await resolveGamertagLink(db, name);
  if (to === "ambiguous-gamertag") return { ok: false, reason: to };
  if (!to) return { ok: false, reason: "recipient-not-linked" };
  if (to.discordId === a.discordId) return { ok: false, reason: "recipient-is-you" };
  // ⚠️ `clan_notices.server_id` is NOT NULL: the one active server, as grantAwardDb picks it.
  const [server] = await db.select({ id: servers.id }).from(servers).where(eq(servers.active, true)).limit(1);
  if (!server) return { ok: false, reason: "no-server" };
  const names = await db.select({ discordId: identityLinks.discordId, gamertag: identityLinks.gamertag })
    .from(identityLinks).where(inArray(identityLinks.discordId, [a.discordId, to.discordId]));
  const toGamertag = names.find((n) => n.discordId === to.discordId)?.gamertag ?? name;
  const fromName = names.find((n) => n.discordId === a.discordId)?.gamertag ?? "Another player";

  return db.transaction(async (tx) => {
    const [g] = await tx.select().from(awardGrants)
      .where(and(eq(awardGrants.id, a.grantId), eq(awardGrants.discordId, a.discordId))).for("update");
    if (!g) return { ok: false, reason: "not-found" } as const;
    if (!isOpenAward(awardState(g, a.now))) return { ok: false, reason: "ended" } as const;
    const remainingMs = awardTimeLeftMs(g, a.now);
    const placeBy = new Date(a.now.getTime() + AWARD_PLACE_BY_MS);
    await tx.update(awardGrants).set({
      discordId: to.discordId, placeBy, remainingMs,
      posX: null, posY: null, posZ: null, placedAt: null, liveFrom: null, expiresAt: null, updatedAt: a.now,
    }).where(eq(awardGrants.id, g.id));
    await tx.update(boosterKitChallenges).set({ closedAt: a.now })
      .where(and(eq(boosterKitChallenges.awardGrantId, g.id), isNull(boosterKitChallenges.closedAt)));
    await tx.insert(awardTransfers).values({
      awardGrantId: g.id, fromDiscordId: a.discordId, toDiscordId: to.discordId, transferredAt: a.now, remainingMs,
    });
    const label = awardsCatalogue()[g.awardKey]?.label ?? g.awardKey;
    await appendClanNoticeTx(tx, {
      serverId: server.id, factionId: null, target: "dm", discordTargetId: to.discordId,
      kind: "award_received", occurredAt: a.now,
      payload: { grantId: g.id, awardKey: g.awardKey, label, fromName, placeBy: placeBy.toISOString(), remainingMs, awardUrl: `${a.siteBaseUrl}/awards/${g.id}` },
    });
    await appendClanNoticeTx(tx, {
      serverId: server.id, factionId: null, target: "dm", discordTargetId: a.discordId,
      kind: "award_given", occurredAt: a.now,
      payload: { grantId: g.id, awardKey: g.awardKey, label, toName: toGamertag },
    });
    return { ok: true, toGamertag } as const;
  });
}
```

Add `inArray` to the `drizzle-orm` import. If `./writes` importing into `./awards` creates an import cycle that breaks module loading, move `resolveGamertagLink` into its own file `packages/roster/src/resolve-gamertag.ts`, re-export it from `writes.ts`, and import it from there; ledger the move.

- [ ] **Step 5: Run to see them pass**

Run: `TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions" pnpm --filter @factions/roster test -- award-transfer awards award-admin` → PASS.

- [ ] **Step 6: Export it, and pin the export lists**

- `packages/roster/src/api.ts`: add `giveAwardDb` and `type GiveAwardOutcome` to the `./awards` import; add `GiveAwardOutcome` to the `export type { ... }` line with the other award types; import `siteBaseUrl` from `"./internal/site-url"` if the file does not already have it; and add beside `cancelAwardPlacement`:

```ts
    /** Give an award to another linked player. Refusals are an outcome. */
    giveAward: (discordId: string, grantId: number, toGamertag: string): Promise<GiveAwardOutcome> =>
      giveAwardDb(getDb(), { discordId, grantId, toGamertag, siteBaseUrl: siteBaseUrl(), now: getNow() }),
```

- `packages/roster/src/index.ts`: add `GiveAwardOutcome` to the award type re-export (line 47) and `giveAward` to the value list (alphabetical, after `editLock`).
- `packages/roster/test/roster-exports.ts` and `apps/web/test/smoke.test.ts`: insert `"giveAward"` between `"editLock"` and `"grantGuestPass"`.
- `apps/bot/test/parity.test.ts`, in `PENDING` after `cancelAwardPlacement`:

```ts
  // 2026-09-30 award transfers: site-only like the other award actions (spec
  // "Out of scope"). `/awards give award: to:` is the shape if it is wanted;
  // `/award` itself is admin-only, so it cannot be a subcommand there.
  giveAward: "awards give",
```

Run: `TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions" pnpm --filter @factions/roster test -- exports` then `pnpm --filter @factions/web test -- smoke` then `TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions" pnpm --filter @factions/bot test -- parity` → PASS. Then typecheck roster, web, bot.

- [ ] **Step 7: Commit**

```bash
git add packages/db/src/schema.ts packages/db/migrations packages/roster/src packages/roster/test apps/web/test/smoke.test.ts apps/bot/test/parity.test.ts
git commit -m "feat(awards): give an award to another linked player

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: The worker resumes the clock

**Files:**
- Modify: `apps/ingest-worker/src/award-tick.ts` (the row select, line ~42, and the stamp, line ~104)
- Test: `apps/ingest-worker/test/award-tick.test.ts`

**Interfaces:**
- Consumes: `awardGrants.remainingMs` (Task 3), `awardClockMs`, `awardTimeLeftMs` (Task 1).

- [ ] **Step 1: Write the failing test**

Add inside `describe("awardTick")`:

```ts
  it("⚠️ resumes a transferred award with the time it had left, not its full length", async () => {
    const [g] = await seed({ remainingMs: 5 * 3_600_000 });
    await tick();
    const [row] = await db.select().from(awardGrants).where(eq(awardGrants.id, g!.id));
    expect(row!.expiresAt!.getTime() - row!.liveFrom!.getTime()).toBe(5 * 3_600_000);
  });

  it("runs an award never transferred for its full length, as before", async () => {
    const [g] = await seed({ durationDays: 7 });
    await tick();
    const [row] = await db.select().from(awardGrants).where(eq(awardGrants.id, g!.id));
    expect(row!.expiresAt!.getTime() - row!.liveFrom!.getTime()).toBe(7 * 86_400_000);
  });
```

Add `eq` to the file's `drizzle-orm` import if missing.

- [ ] **Step 2: Run to see it fail**

Run: `TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions" pnpm --filter @factions/ingest-worker test -- award-tick`
Expected: the first case FAILS (the length is the grant's 7 days).

- [ ] **Step 3: Implement**

In `award-tick.ts`, add `remainingMs: awardGrants.remainingMs,` to the row select; import `awardClockMs, awardTimeLeftMs` from `@factions/domain` (replacing `awardClock` if nothing else uses it); and replace the stamp's clock line:

```ts
      // ⚠️ The grant's own length, never the catalogue's: `duration_days` from
      // the row, or, for a transferred award, the time it had left
      // (`remaining_ms`). `live_from` is null here, so `expires_at` is too, and
      // awardTimeLeftMs reads exactly those two stored lengths.
      const { liveFrom, expiresAt } = awardClockMs(stored.uploadedAt, awardTimeLeftMs(r, deps.now));
```

- [ ] **Step 4: Run to see it pass**

Run the Step 2 command → PASS (all cases). Then `pnpm --filter @factions/ingest-worker typecheck`.

- [ ] **Step 5: Commit**

```bash
git add apps/ingest-worker/src/award-tick.ts apps/ingest-worker/test/award-tick.test.ts
git commit -m "feat(awards): a transferred award resumes with the time it had left

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: `/award list` says who gave it

**Files:**
- Modify: `packages/roster/src/internal/award-admin.ts` (`AwardListRow`, `listAwardsDb`)
- Modify: `apps/bot/src/commands/award.ts` (`summarize`, line ~25)
- Test: `packages/roster/test/award-admin.test.ts`, `apps/bot/test/award-command.test.ts`

**Interfaces:**
- Consumes: `awardTransfers` (Task 3).
- Produces: `AwardListRow.givenBy: string | null` (the Discord id of the most recent giver).

- [ ] **Step 1: Write the failing tests**

In `packages/roster/test/award-admin.test.ts`, add `awardTransfers` to the `@factions/db` import, add `award_transfers` to the `truncate` list, and add:

```ts
  it("lists who last gave each award away", async () => {
    const out = await grant();
    if (!out.ok) throw new Error("grant failed");
    await db.insert(awardTransfers).values([
      { awardGrantId: out.grantId, fromDiscordId: "5", toDiscordId: "6", transferredAt: now, remainingMs: 1 },
      { awardGrantId: out.grantId, fromDiscordId: "6", toDiscordId: "1", transferredAt: new Date(now.getTime() + 1), remainingMs: 1 },
    ]);
    const [r] = await listAwardsDb(db, { discordId: null, now });
    expect(r!.givenBy).toBe("6");
  });

  it("lists givenBy as null for an award never transferred", async () => {
    await grant();
    expect((await listAwardsDb(db, { discordId: null, now }))[0]!.givenBy).toBeNull();
  });
```

In `apps/bot/test/award-command.test.ts`, add `awardTransfers` to the `@factions/db` import and `award_transfers` to the `truncate`, then:

```ts
  it("list names who gave an award away", async () => {
    await spec("award grant").handler(ctx(), input());
    const [g] = await db.select().from(awardGrants);
    await db.insert(awardTransfers).values({ awardGrantId: g!.id, fromDiscordId: "7", toDiscordId: "1", transferredAt: NOW, remainingMs: 1 });
    const r = await spec("award list").handler(ctx(), input({ user: null }));
    expect(r.content).toContain("given by <@7>");
  });
```

- [ ] **Step 2: Run to see them fail**

Run: `TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions" pnpm --filter @factions/roster test -- award-admin` and the same for `@factions/bot` with `-- award-command`.
Expected: FAIL (`givenBy` undefined; no "given by").

- [ ] **Step 3: Implement**

`award-admin.ts`: add `awardTransfers` to the `@factions/db` import and `inArray` to `drizzle-orm`; add `givenBy: string | null;` to `AwardListRow`; in `listAwardsDb`, after the filter and slice, look up givers for the rows kept:

```ts
  const open = rows
    .map((g) => ({
      id: g.id, awardKey: g.awardKey, label: catalogue[g.awardKey]?.label ?? g.awardKey, discordId: g.discordId,
      reason: g.reason, state: awardState(g, a.now), placeBy: g.placeBy, expiresAt: g.expiresAt, durationDays: g.durationDays,
    }))
    .filter((r) => isOpenAward(r.state))
    .slice(0, 25);
  if (open.length === 0) return [];
  // Newest transfer per grant wins: ordered by id, the last write for a grant
  // overwrites the earlier ones in the map.
  const transfers = await db.select({ grantId: awardTransfers.awardGrantId, from: awardTransfers.fromDiscordId })
    .from(awardTransfers).where(inArray(awardTransfers.awardGrantId, open.map((r) => r.id))).orderBy(awardTransfers.id);
  const givenBy = new Map(transfers.map((t) => [t.grantId, t.from]));
  return open.map((r) => ({ ...r, givenBy: givenBy.get(r.id) ?? null }));
```

`award.ts` `summarize`: append the giver when mentioning:

```ts
  const given = mention && r.givenBy ? `, given by <@${r.givenBy}>` : "";
  return `#${r.id} ${r.label} (${days(r.durationDays)}): ${who}, ${STATE[r.state]}${mention ? until : ""}${given}`;
```

- [ ] **Step 4: Run to see them pass**

Run the Step 2 commands → PASS. Typecheck roster and bot.

- [ ] **Step 5: Commit**

```bash
git add packages/roster/src/internal/award-admin.ts apps/bot/src/commands/award.ts packages/roster/test/award-admin.test.ts apps/bot/test/award-command.test.ts
git commit -m "feat(awards): /award list shows who gave an award away

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: The give flow on the award page

**Files:**
- Create: `apps/web/app/api/awards/[id]/give/route.ts`
- Create: `apps/web/app/(site)/awards/[id]/give-award.tsx`
- Modify: `apps/web/lib/award-view.ts` (`remainingMs`), `apps/web/lib/award-copy.ts` (`RESULT_COPY`)
- Modify: `apps/web/app/(site)/awards/[id]/award-flow.tsx` (length line; render `GiveAward`)
- Test: `apps/web/test/award-render.test.tsx` (the route is covered by `api-routes.test.ts`, which requires POST-only, and its logic is `giveAwardDb`, tested in Task 3; the repo has no mocked unit tests for award routes)

**Interfaces:**
- Consumes: roster `giveAward` and `GiveAwardOutcome` (Task 3); `AwardSummary.remainingMs` (Task 3); `timeLeftText` (Task 1).
- Produces: `AwardPageView.remainingMs: number | null`; `POST /api/awards/<id>/give` with body `{ gamertag: string }` answering `{ ok: true }` or `{ ok: false, reason }`.

- [ ] **Step 1: Write the failing tests**

In `apps/web/test/award-render.test.tsx`, add `remainingMs: null` to the `view()` defaults, then add inside `describe("the award page")`:

```ts
  it("offers to give an open award away, and not an ended one", () => {
    expect(render(view())).toContain("Give to another player");
    expect(render(view({ state: "live", expiresAt: "2026-09-29T14:00:00.000Z" }))).toContain("Give to another player");
    expect(render(view({ state: "expired" }))).not.toContain("Give to another player");
  });

  it("says the time left on a transferred award instead of its full length", () => {
    const html = render(view({ remainingMs: 2 * 86_400_000 + 5 * 3_600_000 }));
    expect(html).toContain("It has 2 days 5 hours left once it spawns.");
    expect(html).not.toContain("It runs for");
  });
```

- [ ] **Step 2: Run to see them fail**

Run: `pnpm --filter @factions/web test -- award-render`
Expected: FAIL (no button, no time-left line).

- [ ] **Step 3: The route**

`apps/web/app/api/awards/[id]/give/route.ts`:

```ts
import { giveAward } from "@factions/roster";
import { json } from "@/lib/api";
import { awardGate } from "../../guard";

/**
 * Give this award to another linked player (transfers spec §2).
 *
 * Answers `{ ok: true }` with no view: the award is no longer the caller's, so
 * there is nothing of theirs to re-read. The page sends them to /awards.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const gate = await awardGate(ctx.params);
  if ("response" in gate) return gate.response;
  const body = (await req.json().catch(() => null)) as { gamertag?: unknown } | null;
  if (typeof body?.gamertag !== "string") return json({ ok: false, reason: "recipient-not-linked" }, 400);
  const out = await giveAward(gate.discordId, gate.grantId, body.gamertag);
  if (!out.ok) return json({ ok: false, reason: out.reason }, out.reason === "not-found" ? 404 : 400);
  return json({ ok: true });
}
```

- [ ] **Step 4: View, copy, and the length line**

`award-view.ts`: add `/** Time left when it was last given away; null when never transferred. */ remainingMs: number | null;` to `AwardPageView`, and `remainingMs: v.remainingMs,` in `awardPageView`.

`award-copy.ts` `RESULT_COPY`, add:

```ts
  "recipient-not-linked": "No linked player has that gamertag. They need to link their character first.",
  "recipient-is-you": "That is you. Pick another player.",
  "ambiguous-gamertag": "More than one linked player has that gamertag. Ask them for the exact spelling.",
  "no-server": "That did not save. Try again in a moment.",
```

`award-flow.tsx`: add `timeLeftText` to an `@factions/domain` import, and replace the `runsFor` use:

```tsx
              {(view.state === "unplaced" || view.state === "waiting") && (
                <>{view.remainingMs !== null ? `It has ${timeLeftText(view.remainingMs)} left once it spawns.` : runsFor(view.durationDays)}</>
              )}
```

- [ ] **Step 5: The give flow component**

`apps/web/app/(site)/awards/[id]/give-award.tsx`:

```tsx
"use client";
import { useState } from "react";
import { GamertagField } from "@/app/components/gamertag-field";
import { btnPrimary } from "@/app/components/ui";
import { lookupCopy } from "@/lib/copy-lookup";
import { RESULT_COPY } from "@/lib/award-copy";

/**
 * Give this award to another linked player: name them, confirm, done.
 *
 * ⚠️ Two steps on purpose. The give is instant and cannot be undone, so the
 * confirm names both the award and the player before anything is sent.
 */
export function GiveAward({ grantId, label }: { grantId: number; label: string }) {
  const [stage, setStage] = useState<"closed" | "name" | "confirm">("closed");
  const [to, setTo] = useState("");
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);

  const give = async () => {
    setBusy(true);
    try {
      const res = await fetch(`/api/awards/${grantId}/give`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ gamertag: to }),
      }).catch(() => null);
      if (res?.status === 401) { window.location.assign(`/login?next=/awards/${grantId}`); return; }
      const out = (await res?.json().catch(() => null)) as { ok?: boolean; reason?: string } | null;
      if (out?.ok) { window.location.assign("/awards"); return; }
      setRefusal((typeof out?.reason === "string" ? lookupCopy(RESULT_COPY, out.reason) : undefined) ?? RESULT_COPY.failed!);
      setStage("name");
    } finally {
      setBusy(false);
    }
  };

  if (stage === "closed") {
    return (
      <button type="button" className="mt-5 text-[13px] text-gold underline-offset-4 hover:underline" onClick={() => setStage("name")}>
        Give to another player
      </button>
    );
  }
  if (stage === "confirm") {
    return (
      <div className="mt-5 max-w-[34rem] border border-rule-2 bg-frame p-3.5">
        <p className="text-[13px] leading-relaxed text-ink">Give your {label} to {to}? You can&apos;t undo this.</p>
        <div className="mt-3 flex gap-3">
          <button type="button" className={btnPrimary} disabled={busy} onClick={() => { void give(); }}>Give it to {to}</button>
          <button type="button" className="text-[13px] text-ink-2" disabled={busy} onClick={() => setStage("name")}>Back</button>
        </div>
      </div>
    );
  }
  return (
    <form className="mt-5 max-w-[34rem]" onSubmit={(e) => {
      e.preventDefault();
      const name = String(new FormData(e.currentTarget).get("gamertag") ?? "").trim();
      if (!name) return;
      setTo(name); setRefusal(null); setStage("confirm");
    }}>
      <label className="font-mono text-[11px] uppercase tracking-[0.1em] text-muted" htmlFor="give-to">Give it to</label>
      <GamertagField scope="linked" name="gamertag" id="give-to" defaultValue={to} required autoFocus />
      {refusal && <p role="alert" className="mt-2 text-[13px] text-rust">{refusal}</p>}
      <div className="mt-3 flex gap-3">
        <button type="submit" className={btnPrimary}>Next</button>
        <button type="button" className="text-[13px] text-ink-2" onClick={() => { setStage("closed"); setRefusal(null); }}>Cancel</button>
      </div>
    </form>
  );
}
```

If `btnPrimary`, `text-rust`, `text-gold` or `GamertagField`'s import path differ from what the page already uses, match the page (`award-flow.tsx` imports `btnPrimary` from `@/app/components/ui`). Copy has no em dashes.

In `award-flow.tsx`, import it (`import { GiveAward } from "./give-award";`) and render it after the "Place in game" button block:

```tsx
          {isOpen && !view.challenge && <GiveAward grantId={view.id} label={view.label} />}
```

- [ ] **Step 6: Run to see them pass**

Run: `pnpm --filter @factions/web test -- award-render api-routes notice-copy smoke` → PASS. Then `pnpm --filter @factions/web typecheck`.

- [ ] **Step 7: Commit**

```bash
git add "apps/web/app/api/awards/[id]/give" "apps/web/app/(site)/awards/[id]" apps/web/lib/award-view.ts apps/web/lib/award-copy.ts apps/web/test/award-render.test.tsx
git commit -m "feat(web): give an award to another player from its page

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Docs, changelog, and the full gate

**Files:**
- Modify: `CHANGELOG.md`, `CLAUDE.md` (Event awards row; the lock-order list and its `award_grants` paragraph)

- [ ] **Step 1: Changelog** — under `## [Unreleased]`:

```markdown
### Added

- You can now give an award to another player from its page. It's theirs straight away, with a fresh week to place it. If it was already spawning, it stops at your spot, and its clock pauses until the new owner places it.
```

- [ ] **Step 2: CLAUDE.md**

- Lock-order list: insert `award_transfers` after `award_grants` (`… → bounties → award_grants → award_transfers → faction_events → …`).
- In the paragraph beginning "`award_grants` (event awards) sits just before `faction_events`", add: "`giveAwardDb` (transfers) takes `award_grants` FOR UPDATE → `booster_kit_challenges` → `award_transfers` → `clan_notices`; `award_transfers` is written by that transaction alone."
- Event awards row, before "Spec `docs/superpowers/specs/2026-09-22-awards-design.md`": "⚠️ An owner can give an open award away (`giveAwardDb`, site-only): it resets `place_by`, clears the spot and clock, and saves the time left in `remaining_ms`, which the worker's stamp runs for instead of `duration_days`; never clear `remaining_ms` by hand or a paused award restarts at full length. History in `award_transfers`. Spec `docs/superpowers/specs/2026-09-30-award-transfers-design.md`."

- [ ] **Step 3: Full gate**

Run: `TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions" npx turbo run typecheck test --concurrency=1 --force`
Expected: `Tasks: 32 successful, 32 total`.

- [ ] **Step 4: Commit**

```bash
git add CHANGELOG.md CLAUDE.md
git commit -m "docs(awards): award transfers

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 5: After deploy (with the owner)**

The deploy applies migration 0060. On the live site: give a test award from one account to another, check both DMs arrive, the new owner's page shows the time left, and after placing it and one restart, `/award list` shows "given by" and the clock ends at `live_from + remaining`.
