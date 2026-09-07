import type { Database } from "@factions/db";
import { grantGuestPassDb, revokeGuestPassDb, type GrantGuestPassOutcome, type RevokeGuestPassOutcome } from "./internal";
import { actorFor, isRefusal, type ActorRefusal } from "./actor";
import { resolveGamertagLink } from "./writes";

export type GuestGrantOutcome = GrantGuestPassOutcome | ActorRefusal | "target-not-linked" | "ambiguous-gamertag";
export type GuestTargetRef = { discordId: string } | { gamertag: string };

/**
 * Grant a 24 h guest voice pass, by Discord id (`/guest @user`) or by a
 * linked gamertag (`/clan/settings` has no user picker) — the same
 * gamertag→Discord-id resolution `inviteDb` uses, shared via
 * `resolveGamertagLink` rather than copied. Officer+ only; every other rule
 * (self, already-active, is-member) lives in `grantGuestPassDb`.
 */
export async function grantGuestPassDbFor(
  db: Database, now: Date, actorDiscordId: string, target: GuestTargetRef,
): Promise<{ outcome: GuestGrantOutcome; passId: number | null }> {
  const a = await actorFor(db, actorDiscordId);
  if (isRefusal(a)) return { outcome: a, passId: null };

  let userDiscordId: string;
  if ("discordId" in target) {
    userDiscordId = target.discordId;
  } else {
    const resolved = await resolveGamertagLink(db, target.gamertag);
    if (resolved === "ambiguous-gamertag") return { outcome: "ambiguous-gamertag" as const, passId: null };
    if (!resolved) return { outcome: "target-not-linked" as const, passId: null };
    userDiscordId = resolved.discordId;
  }

  return grantGuestPassDb(db, { factionId: a.factionId, actorDiscordId, userDiscordId, at: now });
}

/** Revoke an open pass early. Officer+ only. */
export async function revokeGuestPassDbFor(db: Database, now: Date, actorDiscordId: string, passId: number): Promise<RevokeGuestPassOutcome | ActorRefusal> {
  const a = await actorFor(db, actorDiscordId);
  if (isRefusal(a)) return a;
  return revokeGuestPassDb(db, { factionId: a.factionId, actorDiscordId, passId, at: now });
}
