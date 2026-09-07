import type { Database } from "@factions/db";
import { vaultLocks, vaultHistory, players, factions } from "@factions/db";
import { and, asc, desc, eq, inArray, isNull } from "drizzle-orm";
import { ROLE_RANK, canSeeLock, randomVaultCode, type ClanRole, type VaultAction } from "@factions/domain";
import { lockFactionTx, fullMemberTx } from "./leadership-store";
import { noticeClanTx, noticeFullMembersTx } from "./notices";
import { gamertagOrId } from "./feed-actor";
import { siteBaseUrl } from "./site-url";

/** The transaction handle drizzle hands to `db.transaction`. */
type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];

/** Mirrors `packages/roster`'s `Role` union (see `roster-store.ts`) — same string literals as domain's `ClanRole`. */
type Role = ClanRole;

export const VAULT_NAME_MAX = 40;
export const VAULT_NOTE_MAX = 140;

const CODE_RE = /^[0-9]{4}$/u;
const validName = (name: string) => name.length >= 1 && name.length <= VAULT_NAME_MAX;
const validNote = (note: string | null) => note === null || note.length <= VAULT_NOTE_MAX;

export type VaultActor = { factionId: number; serverId: number; dayzId: string; discordId: string; role: Role };

/**
 * The gamertag a vault row's own frozen dayz id names — `created_by`,
 * `rotated_by` and `vault_history.by` all store a dayz id (not a discord
 * id, unlike the rest of the roster's notices), so `gamertagOrId` (keyed on
 * discord id) does not apply here. Falls back to the id itself, the same
 * shape `gamertagOrId` uses for the same reason.
 */
async function gamertagByDayzIdTx(tx: Tx, dayzId: string): Promise<string> {
  const [p] = await tx.select({ gamertag: players.gamertag }).from(players).where(eq(players.dayzId, dayzId));
  return p?.gamertag ?? dayzId;
}

// ⚠️ The caller's `VaultActor` is trusted for nothing but `factionId` and
// `discordId` — `role` and `dayzId` are re-derived on every write, inside
// the transaction, right after `lockFactionTx`, via the shared
// `fullMemberTx` (leadership-store.ts). A `VaultActor` built at page load
// (or by a bot command) can be stale by the time the write lands: a
// demoted officer, or a member kicked a moment ago, must be judged on the
// roster row as it stands NOW, not on what the caller believes.

export type AddLockOutcome = "ok" | "not-permitted" | "bad-name" | "bad-note" | "bad-code";
export type EditLockOutcome = "ok" | "not-permitted" | "gone" | "bad-name" | "bad-note";
export type DeleteLockOutcome = "ok" | "not-permitted" | "gone";
export type RevealLockOutcome = "ok" | "not-visible" | "gone";
export type RotateLocksOutcome = "ok" | "not-permitted" | "gone";
export type ConfirmLockOutcome = "ok" | "not-visible" | "gone";

export type VaultLockView = {
  id: number;
  name: string;
  note: string | null;
  minRole: Role;
  createdAt: Date;
  createdBy: string;
  rotatedAt: Date | null;
  rotatedBy: string | null;
  confirmedAt: Date | null;
  changedInGame: boolean;
  exposed: boolean;
};

export type VaultHistoryRow = { at: Date; action: VaultAction; lockName: string; by: string };

export type VaultState = { locks: VaultLockView[]; history: VaultHistoryRow[] | null };

/**
 * Add a lock. Officer+ only (guide ch. 8). `code` is caller-supplied (4
 * digits) or generated with `randomVaultCode`; either way it never leaves
 * this call except through `revealLockDb`.
 */
export async function addLockDb(
  db: Database,
  actor: VaultActor,
  a: { name: string; note: string | null; minRole: Role; code?: string; at: Date; rng?: () => number },
): Promise<{ outcome: AddLockOutcome; lockId: number | null }> {
  return db.transaction(async (tx) => {
    await lockFactionTx(tx, actor.factionId);

    const me = await fullMemberTx(tx, actor.factionId, actor.discordId);
    if (!me || ROLE_RANK[me.role] < ROLE_RANK.officer) return { outcome: "not-permitted" as const, lockId: null };
    if (!validName(a.name)) return { outcome: "bad-name" as const, lockId: null };
    if (!validNote(a.note)) return { outcome: "bad-note" as const, lockId: null };
    if (a.code !== undefined && !CODE_RE.test(a.code)) return { outcome: "bad-code" as const, lockId: null };

    const code = a.code ?? randomVaultCode(a.rng);
    const [row] = await tx.insert(vaultLocks).values({
      factionId: actor.factionId,
      name: a.name,
      code,
      note: a.note,
      minRole: a.minRole,
      createdByDayzId: me.dayzId,
      createdAt: a.at,
    }).returning({ id: vaultLocks.id });

    await tx.insert(vaultHistory).values({
      factionId: actor.factionId, lockId: row!.id, lockName: a.name, action: "added", dayzId: me.dayzId, at: a.at,
    });

    return { outcome: "ok" as const, lockId: row!.id };
  });
}

/** Rename/re-describe/re-gate a lock. Officer+ only; the code is untouched (that is `rotateLocksDb`'s job). */
export async function editLockDb(
  db: Database,
  actor: VaultActor,
  a: { lockId: number; name: string; note: string | null; minRole: Role; at: Date },
): Promise<EditLockOutcome> {
  return db.transaction(async (tx) => {
    await lockFactionTx(tx, actor.factionId);

    const me = await fullMemberTx(tx, actor.factionId, actor.discordId);
    if (!me || ROLE_RANK[me.role] < ROLE_RANK.officer) return "not-permitted" as const;
    if (!validName(a.name)) return "bad-name" as const;
    if (!validNote(a.note)) return "bad-note" as const;

    const [lock] = await tx.select({ id: vaultLocks.id }).from(vaultLocks)
      .where(and(eq(vaultLocks.id, a.lockId), eq(vaultLocks.factionId, actor.factionId))).for("update");
    if (!lock) return "gone" as const;

    await tx.update(vaultLocks).set({ name: a.name, note: a.note, minRole: a.minRole }).where(eq(vaultLocks.id, lock.id));
    await tx.insert(vaultHistory).values({
      factionId: actor.factionId, lockId: lock.id, lockName: a.name, action: "edited", dayzId: me.dayzId, at: a.at,
    });

    return "ok" as const;
  });
}

/** Delete a lock. Officer+ only. The history row freezes the name before the row (and its FK) is gone. */
export async function deleteLockDb(
  db: Database,
  actor: VaultActor,
  a: { lockId: number; at: Date },
): Promise<DeleteLockOutcome> {
  return db.transaction(async (tx) => {
    await lockFactionTx(tx, actor.factionId);

    const me = await fullMemberTx(tx, actor.factionId, actor.discordId);
    if (!me || ROLE_RANK[me.role] < ROLE_RANK.officer) return "not-permitted" as const;

    const [lock] = await tx.select({ id: vaultLocks.id, name: vaultLocks.name }).from(vaultLocks)
      .where(and(eq(vaultLocks.id, a.lockId), eq(vaultLocks.factionId, actor.factionId))).for("update");
    if (!lock) return "gone" as const;

    await tx.insert(vaultHistory).values({
      factionId: actor.factionId, lockId: lock.id, lockName: lock.name, action: "deleted", dayzId: me.dayzId, at: a.at,
    });
    await tx.delete(vaultLocks).where(eq(vaultLocks.id, lock.id));

    return "ok" as const;
  });
}

/**
 * Reveal a lock's code. Any rank meeting `min_role` — not officer+ like the
 * other writes here. `gone` is checked before visibility: a lock that no
 * longer exists has no `min_role` to test.
 */
export async function revealLockDb(
  db: Database,
  actor: VaultActor,
  a: { lockId: number; at: Date },
): Promise<{ outcome: RevealLockOutcome; code: string | null }> {
  return db.transaction(async (tx) => {
    await lockFactionTx(tx, actor.factionId);

    const [lock] = await tx.select({ id: vaultLocks.id, name: vaultLocks.name, code: vaultLocks.code, minRole: vaultLocks.minRole })
      .from(vaultLocks).where(and(eq(vaultLocks.id, a.lockId), eq(vaultLocks.factionId, actor.factionId))).for("update");
    if (!lock) return { outcome: "gone" as const, code: null };

    const me = await fullMemberTx(tx, actor.factionId, actor.discordId);
    if (!me || !canSeeLock(me.role, lock.minRole as Role)) return { outcome: "not-visible" as const, code: null };

    await tx.insert(vaultHistory).values({
      factionId: actor.factionId, lockId: lock.id, lockName: lock.name, action: "revealed", dayzId: me.dayzId, at: a.at,
    });

    return { outcome: "ok" as const, code: lock.code };
  });
}

/**
 * Rotate one lock's code, or every lock in the vault (`lockId: "all"`).
 * Officer+ only. Clears `confirmed_at` and `exposed_at` — a fresh code has
 * not been changed in-game yet, and it is no longer known to anyone who
 * left before this moment. Posts exactly one channel notice and one DM to
 * every full member, whatever the lock count, never with a code.
 */
export async function rotateLocksDb(
  db: Database,
  actor: VaultActor,
  a: { lockId: number | "all"; at: Date; rng?: () => number },
): Promise<{ outcome: RotateLocksOutcome; rotated: number }> {
  return db.transaction(async (tx) => {
    await lockFactionTx(tx, actor.factionId);

    const me = await fullMemberTx(tx, actor.factionId, actor.discordId);
    if (!me || ROLE_RANK[me.role] < ROLE_RANK.officer) return { outcome: "not-permitted" as const, rotated: 0 };

    const where = a.lockId === "all"
      ? eq(vaultLocks.factionId, actor.factionId)
      : and(eq(vaultLocks.id, a.lockId), eq(vaultLocks.factionId, actor.factionId));
    const targets = await tx.select({ id: vaultLocks.id, name: vaultLocks.name }).from(vaultLocks).where(where).for("update");
    if (a.lockId !== "all" && targets.length === 0) return { outcome: "gone" as const, rotated: 0 };
    if (targets.length === 0) return { outcome: "ok" as const, rotated: 0 };

    for (const t of targets) {
      const code = randomVaultCode(a.rng);
      await tx.update(vaultLocks).set({
        code, rotatedAt: a.at, rotatedByDayzId: me.dayzId, confirmedAt: null, exposedAt: null,
      }).where(eq(vaultLocks.id, t.id));
      await tx.insert(vaultHistory).values({
        factionId: actor.factionId, lockId: t.id, lockName: t.name, action: "rotated", dayzId: me.dayzId, at: a.at,
      });
    }

    const [clan] = await tx.select({ name: factions.name }).from(factions).where(eq(factions.id, actor.factionId));

    await noticeClanTx(tx, {
      serverId: actor.serverId, factionId: actor.factionId, kind: "codes_rotated", occurredAt: a.at,
      payload: { gamertag: await gamertagOrId(tx, actor.discordId) },
    });
    await noticeFullMembersTx(tx, {
      serverId: actor.serverId, factionId: actor.factionId, kind: "codes_rotated", occurredAt: a.at,
      payload: { clan: clan?.name ?? "your clan", link: `${siteBaseUrl()}/clan/vault` },
    });

    return { outcome: "ok" as const, rotated: targets.length };
  });
}

/** Confirm a lock's code was changed in-game. Any rank meeting `min_role`. */
export async function confirmLockDb(
  db: Database,
  actor: VaultActor,
  a: { lockId: number; at: Date },
): Promise<ConfirmLockOutcome> {
  return db.transaction(async (tx) => {
    await lockFactionTx(tx, actor.factionId);

    const [lock] = await tx.select({ id: vaultLocks.id, name: vaultLocks.name, minRole: vaultLocks.minRole })
      .from(vaultLocks).where(and(eq(vaultLocks.id, a.lockId), eq(vaultLocks.factionId, actor.factionId))).for("update");
    if (!lock) return "gone" as const;

    const me = await fullMemberTx(tx, actor.factionId, actor.discordId);
    if (!me || !canSeeLock(me.role, lock.minRole as Role)) return "not-visible" as const;

    await tx.update(vaultLocks).set({ confirmedAt: a.at }).where(eq(vaultLocks.id, lock.id));
    await tx.insert(vaultHistory).values({
      factionId: actor.factionId, lockId: lock.id, lockName: lock.name, action: "confirmed", dayzId: me.dayzId, at: a.at,
    });

    return "ok" as const;
  });
}

/**
 * The vault as `actor` may see it: locks whose `min_role` their rank meets,
 * never a `code`. History (last 100, newest first) only for the leader —
 * everyone else gets `null` (spec §10.2).
 */
export async function vaultStateDb(db: Database, actor: VaultActor): Promise<VaultState> {
  return db.transaction(async (tx) => {
    const rows = await tx.select().from(vaultLocks)
      .where(eq(vaultLocks.factionId, actor.factionId))
      .orderBy(asc(vaultLocks.id));

    const locks: VaultLockView[] = [];
    for (const r of rows) {
      const minRole = r.minRole as Role;
      if (!canSeeLock(actor.role, minRole)) continue;
      locks.push({
        id: r.id,
        name: r.name,
        note: r.note,
        minRole,
        createdAt: r.createdAt,
        createdBy: await gamertagByDayzIdTx(tx, r.createdByDayzId),
        rotatedAt: r.rotatedAt,
        rotatedBy: r.rotatedByDayzId ? await gamertagByDayzIdTx(tx, r.rotatedByDayzId) : null,
        confirmedAt: r.confirmedAt,
        changedInGame: r.rotatedAt !== null && (r.confirmedAt === null || r.confirmedAt.getTime() < r.rotatedAt.getTime()),
        exposed: r.exposedAt !== null,
      });
    }

    let history: VaultHistoryRow[] | null = null;
    if (actor.role === "leader") {
      const hrows = await tx.select().from(vaultHistory)
        .where(eq(vaultHistory.factionId, actor.factionId))
        .orderBy(desc(vaultHistory.at))
        .limit(100);
      history = [];
      for (const h of hrows) {
        history.push({ at: h.at, action: h.action as VaultAction, lockName: h.lockName, by: await gamertagByDayzIdTx(tx, h.dayzId) });
      }
    }

    return { locks, history };
  });
}

/**
 * A leaver (kick or leave) exposes every lock they could see that is not
 * already exposed — `ROLE_RANK[min_role] <= ROLE_RANK[leaverRole]`. Called
 * from inside `kick`/`leave`'s own transaction, right after the electorate
 * decrement, which already holds the clan's row (lock order: `vault_locks`
 * after `faction_votes`/ballots — spec §4.12).
 */
export async function exposeLocksTx(
  tx: Tx,
  a: { factionId: number; leaverRole: Role; at: Date },
): Promise<number> {
  const rank = ROLE_RANK[a.leaverRole];
  const visibleMinRoles = (Object.keys(ROLE_RANK) as Role[]).filter((r) => ROLE_RANK[r] <= rank);

  const result = await tx.update(vaultLocks)
    .set({ exposedAt: a.at })
    .where(and(
      eq(vaultLocks.factionId, a.factionId),
      isNull(vaultLocks.exposedAt),
      inArray(vaultLocks.minRole, visibleMinRoles),
    ))
    .returning({ id: vaultLocks.id });

  return result.length;
}
