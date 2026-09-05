import type { Database } from "@factions/db";
import { factionMembers, identityLinks } from "@factions/db";
import {
  declarationForPlayer, declareSoloTx, lockDeclarations, raisedPolesFor, releaseTx,
} from "@factions/declarations";
import { and, eq } from "drizzle-orm";
import { activeServerId } from "./server";

export const DECLARE_SOLO_REASONS = ["not-linked", "in-clan", "no-raise", "too-close", "pole-taken", "owner-has-base"] as const;
export type DeclareSoloReason = (typeof DECLARE_SOLO_REASONS)[number];
export type DeclareSoloOutcome = { ok: true } | { ok: false; reason: DeclareSoloReason };

export type BaseView =
  | { linked: false }
  | {
      linked: true; gamertag: string; inClan: boolean;
      declaration: { poleKey: string; x: number; z: number; declaredAt: Date } | null;
      candidates: { poleKey: string; x: number; z: number; raisedAt: Date }[];
    };

/**
 * /base's one read. The candidates are poles THIS player raised a flag
 * at — the log's own record of where they have been — and the declaration
 * is their own. No other player's pole ever passes through here (CLAUDE.md:
 * pole coordinates are a raid target). `y` is dropped: a base is a point on
 * the map.
 */
export async function baseForDb(db: Database, discordId: string): Promise<BaseView> {
  const [link] = await db.select({ dayzId: identityLinks.dayzId, gamertag: identityLinks.gamertag })
    .from(identityLinks).where(eq(identityLinks.discordId, discordId));
  if (!link) return { linked: false };
  const serverId = await activeServerId(db);
  const [member] = await db.select({ id: factionMembers.id }).from(factionMembers)
    .where(and(eq(factionMembers.serverId, serverId), eq(factionMembers.dayzId, link.dayzId)));
  const declaration = await declarationForPlayer(db, serverId, link.dayzId);
  const raised = await raisedPolesFor(db, serverId, link.dayzId);
  return {
    linked: true, gamertag: link.gamertag, inClan: member !== undefined,
    declaration: declaration
      ? { poleKey: declaration.poleKey, x: Number(declaration.x), z: Number(declaration.z), declaredAt: declaration.declaredAt }
      : null,
    candidates: raised
      .filter((r) => r.poleKey !== declaration?.poleKey)
      .map((r) => ({ poleKey: r.poleKey, x: r.x, z: r.z, raisedAt: r.occurredAt })),
  };
}

/**
 * Solo declare (spec §5.2), the site's way. Lock order (spec §4.12): the
 * server's declaration lock FIRST, then the link read, then `declareSoloTx`
 * (declarations → poles). Taking the advisory lock before reading the link
 * is what makes this safe against `unlink`, which takes the same lock before
 * releasing and deleting: whichever commits first, the other sees its result.
 * The 200 m rule, the one-base-per-player rule and the evidence requirement
 * are all `declareTx`'s and are not restated here.
 */
export async function declareSoloDb(db: Database, discordId: string, poleKey: string, now: Date): Promise<DeclareSoloOutcome> {
  return db.transaction(async (tx) => {
    const serverId = await activeServerId(tx);
    await lockDeclarations(tx, serverId);
    const [link] = await tx.select({ dayzId: identityLinks.dayzId }).from(identityLinks)
      .where(eq(identityLinks.discordId, discordId));
    if (!link) return { ok: false as const, reason: "not-linked" as const };
    const out = await declareSoloTx(tx, { serverId, dayzId: link.dayzId, poleKey, at: now });
    return out.ok ? { ok: true as const } : { ok: false as const, reason: out.reason };
  });
}

/** Release the caller's solo base; the pole's 3-day grace is `releaseTx`'s. */
export async function releaseSoloDb(db: Database, discordId: string, now: Date): Promise<{ released: boolean }> {
  return db.transaction(async (tx) => {
    const serverId = await activeServerId(tx);
    const [link] = await tx.select({ dayzId: identityLinks.dayzId }).from(identityLinks)
      .where(eq(identityLinks.discordId, discordId));
    if (!link) return { released: false };
    await lockDeclarations(tx, serverId);
    return { released: await releaseTx(tx, { dayzId: link.dayzId, serverId }, now) };
  });
}
