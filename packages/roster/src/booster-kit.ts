import type { Database } from "@factions/db";
import { boosterKitChallenges, boosterKits, discordBoosters } from "@factions/db";
import { KIT_PLACEMENT_TTL_MS, KIT_SLOTS, armbandFor, emoteLabel, isAllowed, type KitSlot } from "@factions/domain";
import { boosterCatalogue } from "@factions/domain/catalogue";
import { and, desc, eq, isNull } from "drizzle-orm";
import { viewerForDb } from "./viewer";
import { issuePlacementChallenge } from "./internal/kit-placement-issue";

export type KitStep = { token: string; label: string };
export type KitSpot = { x: number; y: number; z: number; placedAt: Date | null };
export type KitArmband = { className: string; texture: string; clanName: string; clanTag: string };
export type KitChallenge = { steps: KitStep[]; expiresAt: Date };

/**
 * ⚠️ An OUTCOME, not a throw, and the distinction is load-bearing. A refused
 * pick is an answer the page must give the player; a failed query is an
 * outage the page must NOT dress up as their mistake. Only the first is a
 * value here, so anything unexpected below propagates as a real error.
 */
export type SaveKitOutcome = { ok: true } | { ok: false; reason: "bad-slot" | "bad-pick" };

export type BoosterKitView = {
  /** From `discord_boosters`, which the bot's booster tick keeps current. */
  boosting: boolean;
  linked: { gamertag: string } | null;
  slots: Record<KitSlot, string | null>;
  /** Where the kit lands, once a placement sequence has been witnessed in game. */
  spot: KitSpot | null;
  /**
   * ⚠️ DERIVED from the clan's flag every read, never stored — the tenth item
   * in a kit. Storing it would go stale the moment the clan changes flag, and
   * the spawner file derives it the same way (booster-kits.ts).
   */
  armband: KitArmband | null;
  challenge: KitChallenge | null;
};

const isKitSlot = (slot: string): slot is KitSlot => (KIT_SLOTS as readonly string[]).includes(slot);

/**
 * Everything the kit page renders, in one read.
 *
 * ⚠️ Deliberately answers for a NON-booster too, in full. The page explains
 * the perk to someone deciding whether to boost, so refusing to read here
 * would gate the one page that has to sell it.
 */
export async function boosterKitForDb(db: Database, discordId: string, now: Date): Promise<BoosterKitView> {
  const [viewer, [booster], [kit], [live]] = await Promise.all([
    viewerForDb(db, discordId),
    db.select().from(discordBoosters).where(eq(discordBoosters.discordId, discordId)),
    db.select().from(boosterKits).where(eq(boosterKits.discordId, discordId)),
    db.select().from(boosterKitChallenges)
      .where(and(eq(boosterKitChallenges.discordId, discordId), isNull(boosterKitChallenges.closedAt)))
      .orderBy(desc(boosterKitChallenges.id)).limit(1),
  ]);

  const slots = Object.fromEntries(KIT_SLOTS.map((s) => [s, kit?.[s] ?? null])) as Record<KitSlot, string | null>;

  // ⚠️ All three coordinates or none. A null reaching Number() below would be
  // 0, which reads on the page as a real spot at the corner of the map.
  const spot = kit && kit.posX !== null && kit.posY !== null && kit.posZ !== null
    ? { x: Number(kit.posX), y: Number(kit.posY), z: Number(kit.posZ), placedAt: kit.placedAt }
    : null;

  const armbandClass = viewer.clan ? armbandFor(viewer.clan.texture) : null;
  const armband = viewer.clan && armbandClass
    ? { className: armbandClass, texture: viewer.clan.texture, clanName: viewer.clan.name, clanTag: viewer.clan.tag }
    : null;

  return {
    boosting: booster !== undefined,
    linked: viewer.link ? { gamertag: viewer.link.gamertag } : null,
    slots,
    spot,
    armband,
    // ⚠️ Expiry is applied here, not in the WHERE. The bot's tick closes an
    // expired row when it next sees an emote from that character, so a row
    // can sit open and stale; showing it would tell the player a sequence
    // still works when it does not.
    challenge: live && live.expiresAt > now
      ? { steps: live.sequence.map((token) => ({ token, label: emoteLabel(token) ?? token })), expiresAt: live.expiresAt }
      : null,
  };
}

/**
 * Write one of the nine slots.
 *
 * ⚠️ `isAllowed` against the committed catalogue is the ONLY thing standing
 * between a form POST and an arbitrary class name reaching the server's
 * spawner file. A refused pick comes back as `ok: false` and is never
 * written: a save that quietly dropped the value would report success and
 * spawn nothing.
 *
 * ⚠️ Writes the slot column and `updated_at`, and NOTHING else. The position
 * columns belong to the placement challenge (spec §2.6) — editing gear must
 * never disturb a spot the player marked in game, and an upsert that spelled
 * out the whole row would reset it to null on every save.
 */
export async function saveBoosterKitSlotDb(db: Database, a: {
  discordId: string; slot: string; className: string; now: Date;
}): Promise<SaveKitOutcome> {
  if (!isKitSlot(a.slot)) return { ok: false, reason: "bad-slot" };
  const className = a.className.trim();
  if (className !== "" && !isAllowed(boosterCatalogue(), a.slot, className)) {
    return { ok: false, reason: "bad-pick" };
  }
  const value = className === "" ? null : className;
  await db.insert(boosterKits)
    .values({ discordId: a.discordId, [a.slot]: value, updatedAt: a.now })
    .onConflictDoUpdate({ target: boosterKits.discordId, set: { [a.slot]: value, updatedAt: a.now } });
  return { ok: true };
}

/**
 * Draw the emote sequence that marks where the kit spawns, or null when the
 * account has no linked character to perform it.
 *
 * ⚠️ One call into `issuePlacementChallenge`, which is shared with the bot's
 * `kitPlacementTick` through `@factions/roster/internal`. The rule about what
 * a challenge is and how many may be open lives there, once.
 */
export async function startKitPlacementDb(db: Database, a: {
  discordId: string; now: Date; rng: () => number;
}): Promise<KitChallenge | null> {
  const issued = await issuePlacementChallenge(db, {
    discordId: a.discordId, now: a.now, ttlMs: KIT_PLACEMENT_TTL_MS, rng: a.rng,
  });
  if (!issued) return null;
  return {
    steps: issued.sequence.map((token) => ({ token, label: emoteLabel(token) ?? token })),
    expiresAt: issued.expiresAt,
  };
}
