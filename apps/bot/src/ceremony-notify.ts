import type { Database } from "@factions/db";
import { ceremonies, ceremonyParticipants } from "@factions/db";
import { and, asc, eq, isNull } from "drizzle-orm";
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
 * ⚠️ Delivery is tracked PER PARTICIPANT. A ceremony deliberately carries no
 * channel id, so `Sender`'s public-channel fallback cannot fire — a rival
 * watching a channel must never learn which pole is unclaimed — which means
 * `send` THROWS for anyone with DMs closed. Sending everyone inside one
 * try/catch therefore aborts at the first unreachable player (nobody after
 * them hears) and never marks the ceremony, so the next tick re-DMs everyone
 * who already heard, every tick, for the ceremony's whole 24h life.
 *
 * Marking the ceremony done and moving on is the other wrong answer: it drops
 * an unreachable founder from their own ceremony silently. Same principle as
 * `notifyCompleted` — a real binding retries until it lands. Per participant,
 * the retry is narrowed to exactly the person still owed a message.
 *
 * The ceremony's own `notified_at` is set only once every participant is
 * marked, so it stays an honest "everyone has been told".
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
      .where(eq(ceremonyParticipants.ceremonyId, c.id))
      // Stable order so the DM's participant list reads the same on a retry.
      .orderBy(asc(ceremonyParticipants.id));
    if (participants.length === 0) continue;
    // The DM names everyone counted, including those already delivered — the
    // count is the near-miss signal and must not shrink on a retry.
    const content = formatCeremonyDm({ poleKey: c.poleKey, participants, expiresAt: c.expiresAt });

    let failed = false;
    for (const p of participants) {
      if (p.notifiedAt !== null) continue;
      try {
        // A ceremony has no originating channel, and an empty channelId
        // makes Sender's DM-closed fallback fail rather than post publicly.
        await send({ discordId: p.discordId, channelId: "", content });
        await db.update(ceremonyParticipants)
          .set({ notifiedAt: now() })
          .where(eq(ceremonyParticipants.id, p.id));
      } catch (err) {
        failed = true;
        // One line per ceremony per bot instance: a permanently unreachable
        // player must not print on every tick forever.
        if (!logged.has(c.id)) {
          console.error(`ceremony DM failed for ceremony ${c.id}`, err);
          logged.add(c.id);
        }
      }
    }
    if (failed) continue;

    await db.update(ceremonies).set({ notifiedAt: now() }).where(eq(ceremonies.id, c.id));
    logged.delete(c.id);
    announced++;
  }
  return announced;
}
