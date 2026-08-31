import type { Database } from "@factions/db";
import { ceremonies, ceremonyParticipants } from "@factions/db";
import { and, eq, isNull } from "drizzle-orm";
import { createNotifyFailureLog, type NotifyFailureLog, type Sender } from "./notify.js";

export function formatCeremonyDm(c: {
  poleKey: string;
  participants: { gamertag: string }[];
  expiresAt: Date;
}): string {
  const names = c.participants.map((p) => `**${p.gamertag}**`).join(", ");
  return [
    "**A ceremony was witnessed**",
    "",
    `At the flagpole at \`${c.poleKey}\`, ${c.participants.length} linked players raised the neutral flag together.`,
    "",
    `Counted: ${names} — **${c.participants.length} linked** players.`,
    // The near-miss is otherwise invisible: an unlinked participant has no
    // Discord account to write to, so the count is the only way a group that
    // came up short can work out who still needs to run /link.
    "If someone is missing from that list, they had not run `/link` when the ceremony was read.",
    "",
    "Any one of you can found the faction with `/faction claim`.",
    `This expires <t:${Math.floor(c.expiresAt.getTime() / 1000)}:R>.`,
  ].join("\n");
}

/**
 * DM the participants of every ceremony not yet announced.
 *
 * ⚠️ `notified_at` is written only after EVERY participant's DM succeeds. A
 * partial success retries the whole ceremony, which may re-DM someone — the
 * right trade: a duplicate message is a nuisance, a founding member who never
 * hears about their own ceremony is a lost faction.
 */
export async function notifyCeremonies(
  db: Database,
  send: Sender,
  now: () => Date,
  logged: NotifyFailureLog = createNotifyFailureLog(),
): Promise<number> {
  const pending = await db.select().from(ceremonies)
    .where(and(eq(ceremonies.status, "provisional"), isNull(ceremonies.notifiedAt)));

  let announced = 0;
  for (const c of pending) {
    const participants = await db.select().from(ceremonyParticipants)
      .where(eq(ceremonyParticipants.ceremonyId, c.id));
    if (participants.length === 0) continue;
    const content = formatCeremonyDm({ poleKey: c.poleKey, participants, expiresAt: c.expiresAt });
    try {
      for (const p of participants) {
        // A ceremony has no originating channel, and an empty channelId
        // makes Sender's DM-closed fallback fail rather than post publicly —
        // a rival watching a channel must never learn which pole is unclaimed.
        await send({ discordId: p.discordId, channelId: "", content });
      }
      await db.update(ceremonies).set({ notifiedAt: now() }).where(eq(ceremonies.id, c.id));
      logged.delete(c.id);
      announced++;
    } catch (err) {
      if (!logged.has(c.id)) {
        console.error(`ceremony DM failed for ceremony ${c.id}`, err);
        logged.add(c.id);
      }
    }
  }
  return announced;
}
