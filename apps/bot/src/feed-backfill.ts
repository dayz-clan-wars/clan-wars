/**
 * One-off: give the factions that already exist their founding history, so
 * the feed's first run reads as a record rather than starting mid-story.
 *
 * ⚠️ A deliberate deploy step, never called at startup. The least controlled
 * moment to bulk-insert into production is the moment a process happens to
 * boot — the same rule, and the same reasoning, as `runMigrations`.
 *
 * ⚠️ It can only synthesize what the columns still hold. Renames, rebinds and
 * dormancy episodes that already happened are unrecoverable: the columns that
 * recorded them are overwritten or nulled by design. What this produces is a
 * founding record, not a complete one.
 *
 * Usage:
 *   set -a && . .env && set +a && npx tsx apps/bot/src/feed-backfill.ts
 */
import { createClient, factions, factionEvents, type Database } from "@factions/db";
import { asc, inArray, sql } from "drizzle-orm";
import { HOLDING_STATUSES } from "@factions/domain";

// Widened to a mutable array: HOLDING_STATUSES is `as const` (a readonly
// tuple) so every faction/domain consumer gets full literal-type checking,
// but drizzle's inArray() requires a plain mutable array.
const HOLDING: string[] = [...HOLDING_STATUSES];

export async function backfillFactionEvents(db: Database): Promise<{ inserted: number; skipped: number }> {
  // ⚠️ Restricted to HOLDING_STATUSES (reserved/active/dormant), not every
  // status. A `lapsed` or `disbanded` faction's flag, tag and pole are
  // already back in the pool — backfilling its founding would announce a
  // founding the feed never closes, since there is no lapse/disband row
  // behind it to say the faction is gone. Sourced from the same constant
  // that mirrors the three partial unique indexes, so this cannot drift from
  // what "holds an identity" means everywhere else.
  const rows = await db.select({
    id: factions.id, serverId: factions.serverId,
    name: factions.name, tag: factions.tag, texture: factions.texture,
    createdAt: factions.createdAt, activatedAt: factions.activatedAt,
  }).from(factions).where(inArray(factions.status, HOLDING)).orderBy(asc(factions.id));

  let inserted = 0;
  let skipped = 0;

  for (const f of rows) {
    // ⚠️ Per-faction transaction, not per-row. Without it, a crash between
    // the `founded` insert and the `activated` insert leaves a faction with
    // only half its history — and the idempotence check below then sees
    // "this faction already has a row" on every future run and skips it
    // forever. The missing `activated` row could never be recovered. Scoping
    // the transaction to one faction (rather than the whole loop) means a
    // crash only costs the faction it interrupted — factions already
    // committed before it stay committed.
    const result = await db.transaction(async (tx) => {
      // ⚠️ Idempotent per faction, not per row. Run twice by accident during
      // a deploy and every founding is announced a second time — to a public
      // channel, where it cannot be taken back.
      const existing = await tx.select({ n: sql<number>`count(*)::int` })
        .from(factionEvents).where(sql`${factionEvents.factionId} = ${f.id}`);
      if ((existing[0]?.n ?? 0) > 0) return { insertedHere: 0, skippedHere: 1 };

      // ⚠️ No actor. The founder's identity is not on the factions row, and
      // resolving `leader_discord_id` would name whoever holds the seat TODAY
      // as the person who founded it — which for a faction that has since
      // transferred leadership is simply false.
      const payload = { name: f.name, tag: f.tag, texture: f.texture };

      await tx.insert(factionEvents).values({
        serverId: f.serverId, factionId: f.id, kind: "founded",
        occurredAt: f.createdAt, payload,
      });
      let insertedHere = 1;

      if (f.activatedAt) {
        await tx.insert(factionEvents).values({
          serverId: f.serverId, factionId: f.id, kind: "activated",
          occurredAt: f.activatedAt, payload,
        });
        insertedHere++;
      }

      return { insertedHere, skippedHere: 0 };
    });

    inserted += result.insertedHere;
    skipped += result.skippedHere;
  }

  return { inserted, skipped };
}

// Only when run directly, so the test can import the function.
if (import.meta.url === `file://${process.argv[1]}`) {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set.");
  const result = await backfillFactionEvents(createClient(url));
  console.log(`backfill: inserted ${result.inserted} event(s), skipped ${result.skipped} faction(s)`);
  process.exit(0);
}
