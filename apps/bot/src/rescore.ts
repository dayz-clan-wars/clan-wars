import type { Database } from "@factions/db";
import { events, factions, raids, seasonStandings, seasons } from "@factions/db";
import { RAID_DEDUP_MS, clanValue, raidPoints, scoringWeekStartOf } from "@factions/domain";
import { and, asc, eq, gte, lt } from "drizzle-orm";
import { membershipAt } from "./membership-tick.js";
import { classifyLower, clanOnlineAt, seasonRaidFacts, type LowerVerdict } from "./raid-detect.js";
import { readFlagPayload } from "./raid-tick.js";
import { rebuildStandingsTx } from "./standings.js";

type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];

/** An old-flag raid the live consumer never scored, found by the replay. */
export type RetroRaid = {
  id: number; at: Date; lowerer: string; raider: string | null; victim: string;
  away: boolean; lowerCount: number; online: boolean; points: number;
};

export type RescoreReport = {
  inserted: RetroRaid[];
  rows: { id: number; at: Date; raider: string | null; victim: string; online: boolean; oldPoints: number; newPoints: number }[];
  disagreements: string[];
};

/** Thrown to roll a dry run back after it has computed everything an apply would. */
class DryRun extends Error {}

/** One raid row as the scan sees it: the season's existing rows plus the ones it inserts. */
type ScanRow = {
  id: number; existing: boolean; victimFactionId: number; raiderFactionId: number | null; raiderDayzId: string;
  firstLowerAt: Date; firstLowerEventId: number; lastLowerEventId: number;
  retro?: RetroRaid;
};

/**
 * Rescore one season under the raid value rules (value spec §6): find the
 * old-flag raids the live consumer never scored, insert them, then reprice
 * every raid row and rebuild `season_standings`.
 *
 * All in ONE transaction. A dry run (`apply: false`) runs the exact same code
 * and then rolls back, so what it prints is what an apply would commit, not a
 * second implementation that could disagree with it.
 *
 * What it never touches, per the owner's "closed weeks are frozen" ruling:
 * an existing row's victim, raider, `week_start` and lower ids/timestamps
 * (only `points` and `victim_online` are rewritten), `alpha_weeks`, and the
 * war-log and notice queues. A retro insert posts nothing: a burst of
 * back-dated raid lines would read as live raids.
 *
 * Re-running `apply` is a no-op: the inserted rows cover their own lowers on
 * the next scan, and pricing is a pure function of the rows.
 */
export async function rescoreSeason(db: Database, seasonId: number, opts: { apply: boolean }): Promise<RescoreReport> {
  let report: RescoreReport | undefined;
  try {
    await db.transaction(async (tx) => {
      report = await rescoreTx(tx, seasonId);
      if (!opts.apply) throw new DryRun();
    });
  } catch (err) {
    if (!(err instanceof DryRun)) throw err;
  }
  return report!;
}

async function rescoreTx(tx: Tx, seasonId: number): Promise<RescoreReport> {
  // The season row first: it is the one thing every writer of this season's
  // raids reads, so holding it serialises two rescores. ⚠️ The bot must
  // still be stopped (runbook): raid-tick does not lock `seasons`, so a live
  // raid landing mid-rescore would be priced against the old rows.
  const [season] = await tx.select().from(seasons).where(eq(seasons.id, seasonId)).for("update");
  if (!season) throw new Error(`season ${seasonId} does not exist`);
  // `season_standings` before `raids`, per §4.12, even though the rebuild at
  // the end is the only writer of it here.
  await tx.select({ id: seasonStandings.id }).from(seasonStandings)
    .where(eq(seasonStandings.seasonId, seasonId)).for("update", { of: seasonStandings });

  const clans = new Map((await tx.select({ id: factions.id, tag: factions.tag, activatedAt: factions.activatedAt })
    .from(factions).where(eq(factions.serverId, season.serverId))).map((f) => [f.id, f]));
  const tag = (id: number | null) => (id === null ? null : clans.get(id)?.tag ?? `#${id}`);

  const scan: ScanRow[] = (await tx.select().from(raids).where(eq(raids.seasonId, seasonId)).orderBy(asc(raids.id)))
    .map((r) => ({ ...r, existing: true }));
  const byFirst = new Map(scan.map((r) => [r.firstLowerEventId, r]));
  const byLast = new Map(scan.filter((r) => r.lastLowerEventId !== r.firstLowerEventId).map((r) => [r.lastLowerEventId, r]));
  const inserted: RetroRaid[] = [];
  const disagreements: string[] = [];

  const lowers = await tx.select().from(events).where(and(
    eq(events.type, "flag.lowered"),
    eq(events.serverId, season.serverId),
    gte(events.occurredAt, season.startedAt),
    ...(season.endedAt ? [lt(events.occurredAt, season.endedAt)] : []),
  )).orderBy(asc(events.id));

  for (const ev of lowers) {
    const p = readFlagPayload(ev.payload);
    if (!p) continue;
    // ⚠️ Always replay. Status history is not recorded, so a clan dormant
    // TODAY must still be a valid victim of a lower from last week; the live
    // rule (active only) would silently drop every raid on it.
    //
    // "Declared base" here is a CURRENT `declarations` row on the pole with
    // `declared_at <= at` (classifyLower's own predicate). That is the
    // spec's allowed approximation: a base released or moved since reads as
    // undeclared for lowers before the move, and a pole declared later never
    // reads as a base before it was one.
    const verdict = await classifyLower(tx, { serverId: ev.serverId, occurredAt: ev.occurredAt, dayzId: p.dayzId, poleKey: p.poleKey, texture: p.texture }, { replay: true });
    const raiderFid = await membershipAt(tx, ev.serverId, p.dayzId, ev.occurredAt);
    const describe = (recorded: string) =>
      `${ev.occurredAt.toISOString()} ${p.gamertag} lowered ${p.texture}: recorded ${recorded}, classified ${verdictText(verdict, tag(raiderFid), tag)}`;

    // A lower that IS an existing row's first or last lower is never a new
    // raid: one lowering is never two raids. Disagreeing with the row is
    // reported, never acted on.
    const own = byFirst.get(ev.id) ?? byLast.get(ev.id);
    if (own) {
      if (verdict.kind !== "raid" || verdict.victimFactionId !== own.victimFactionId) {
        disagreements.push(describe(`${tag(own.raiderFactionId) ?? "solo"}→${tag(own.victimFactionId)}`));
      }
      continue;
    }
    if (verdict.kind !== "raid") continue;
    const victim = verdict.victimFactionId;

    // Covered: inside a row's lower-id range for the SAME victim. Ranges
    // interleave other raids' lowers, so a range alone is not enough.
    if (scan.some((r) => r.victimFactionId === victim && r.firstLowerEventId <= ev.id && ev.id <= r.lastLowerEventId)) continue;

    // Dedup, as raid-tick does it: same raider clan (or, solo, the same
    // player) on the same victim inside RAID_DEDUP_MS. The raider is the clan
    // AT the lower (membership_history), never today's roster.
    const sameRaider = (r: ScanRow) => (raiderFid === null ? r.raiderFactionId === null && r.raiderDayzId === p.dayzId : r.raiderFactionId === raiderFid);
    const t = ev.occurredAt.getTime();
    // ⚠️ Existing rows are checked in BOTH directions. Live, a later row
    // cannot exist yet; here it can, and inserting an earlier retro row in
    // front of it would score one raid twice.
    const existingOpen = scan.find((r) => r.existing && r.victimFactionId === victim && sameRaider(r)
      && Math.abs(r.firstLowerAt.getTime() - t) < RAID_DEDUP_MS);
    if (existingOpen) continue; // deduped against a row we must not change: not a disagreement
    const retroOpen = scan.filter((r) => !r.existing && r.victimFactionId === victim && sameRaider(r) && r.firstLowerAt.getTime() > t - RAID_DEDUP_MS)
      .sort((a, b) => b.firstLowerAt.getTime() - a.firstLowerAt.getTime())[0];
    if (retroOpen) {
      // Absorb, as raid-tick does: advance the last lower, count it, score nothing.
      if (ev.id > retroOpen.lastLowerEventId) {
        retroOpen.lastLowerEventId = ev.id;
        retroOpen.retro!.lowerCount++;
        await tx.update(raids).set({ lastLowerAt: ev.occurredAt, lastLowerEventId: ev.id, lowerCount: retroOpen.retro!.lowerCount }).where(eq(raids.id, retroOpen.id));
      }
      continue;
    }
    // Only old-flag (away) raids are new under these rules. A base raid with
    // no row is one the live consumer refused (e.g. the victim was not
    // active then), so it is reported for a human, not inserted blind.
    if (!verdict.away) {
      disagreements.push(describe("no raid row"));
      continue;
    }
    // Points and online are placeholders: every row is priced below, once
    // all rows (and so all ids) exist.
    const [row] = await tx.insert(raids).values({
      seasonId, serverId: ev.serverId, victimFactionId: victim, raiderDayzId: p.dayzId, raiderFactionId: raiderFid,
      firstLowerEventId: ev.id, firstLowerAt: ev.occurredAt, lastLowerAt: ev.occurredAt, lastLowerEventId: ev.id, lowerCount: 1,
      // Retro rows keep null ranks on purpose: the standings at the original
      // instant are not reconstructible, and giant_killer only needs live rows.
      points: 0, victimOnline: false, away: true, victimRankAtLower: null, rankedCountAtLower: null,
      weekStart: scoringWeekStartOf(ev.occurredAt),
    }).returning({ id: raids.id });
    const retro: RetroRaid = { id: row!.id, at: ev.occurredAt, lowerer: p.gamertag, raider: tag(raiderFid), victim: tag(victim)!, away: true, lowerCount: 1, online: false, points: 0 };
    inserted.push(retro);
    scan.push({ id: row!.id, existing: false, victimFactionId: victim, raiderFactionId: raiderFid, raiderDayzId: p.dayzId, firstLowerAt: ev.occurredAt, firstLowerEventId: ev.id, lastLowerEventId: ev.id, retro });
  }

  // Price every row in (first_lower_at, id) order, each excluding its own id:
  // exactly what raid-tick saw when it wrote that row (every earlier row, a
  // same-instant row only if written first). Points are a pure function of
  // the rows, so the order only fixes the report's.
  const facts = await seasonRaidFacts(tx, seasonId);
  const all = await tx.select().from(raids).where(eq(raids.seasonId, seasonId)).orderBy(asc(raids.firstLowerAt), asc(raids.id));
  const rows: RescoreReport["rows"] = [];
  for (const r of all) {
    const online = await clanOnlineAt(tx, r.serverId, r.victimFactionId, r.firstLowerAt);
    // ⚠️ A null activated_at prices as activated at the lower (worth 0), the
    // same fallback raid-tick uses; never epoch (full price).
    const activatedAt = clans.get(r.victimFactionId)?.activatedAt ?? r.firstLowerAt;
    const value = clanValue({ id: r.victimFactionId, activatedAt }, facts, r.firstLowerAt, r.id);
    // Solo raids score nothing, as live.
    const points = r.raiderFactionId === null ? 0 : raidPoints(value, online);
    if (points !== r.points || online !== r.victimOnline) {
      await tx.update(raids).set({ points, victimOnline: online }).where(eq(raids.id, r.id));
    }
    const retro = inserted.find((x) => x.id === r.id);
    if (retro) { retro.points = points; retro.online = online; }
    rows.push({ id: r.id, at: r.firstLowerAt, raider: tag(r.raiderFactionId), victim: tag(r.victimFactionId)!, online, oldPoints: retro ? 0 : r.points, newPoints: points });
  }

  await rebuildStandingsTx(tx, seasonId);
  return { inserted, rows, disagreements };
}

function verdictText(v: LowerVerdict, raider: string | null, tag: (id: number) => string | null): string {
  if (v.kind === "none") return "none";
  return `${raider ?? "solo"}→${tag(v.victimFactionId)} ${v.away ? "away" : "at base"}`;
}
