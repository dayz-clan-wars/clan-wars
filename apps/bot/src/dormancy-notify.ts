import type { Sender } from "./notify.js";
import type { DormancyNotice } from "./dormancy-tick.js";

/**
 * ⚠️ No pole coordinates. The leader is entitled to them, but a DM is
 * screenshottable and this message does not need them — same rule as
 * `/faction info`'s members-only pole line.
 */
export function formatDormancyDm(n: DormancyNotice): string {
  if (n.kind === "revive") {
    return [
      `**${n.name}** [${n.tag}] is active again`,
      "",
      "Your flag is flying, so the clock is reset. Supplies resume at the next server restart.",
    ].join("\n");
  }

  // Interpolated from the window, not hardcoded: BOT_DORMANT_AFTER_MS is
  // configuration, and a message naming the wrong number is worse than one
  // that says nothing.
  const days = Math.round(n.dormantAfterMs / 86_400_000);
  const dayWord = days === 1 ? "day" : "days";

  return [
    `**${n.name}** [${n.tag}] has gone dormant`,
    "",
    // The game says nothing when a flag expires, so this is the only warning
    // a leader ever gets.
    `Your flag has not been raised in ${days} ${dayWord}, so the base it protects has started to decay ` +
    "and your supply kit has stopped.",
    "",
    "Raise your flag in game to start it again — supplies come back at the next server restart.",
    // disbandAt is always set for a "dormant" notice — see DormancyNotice.
    `If nobody raises it, the flag, tag and pole return to the pool <t:${Math.floor(n.disbandAt!.getTime() / 1000)}:R>.`,
  ].join("\n");
}

/**
 * DM the leader of each faction that changed state. Returns how many landed.
 *
 * ⚠️ `channelId` is deliberately empty. `send` falls back to posting in a
 * channel when a DM fails, and for dormancy that fallback would announce to
 * everyone whose base is currently undefended. An empty id makes the fallback
 * throw rather than post, which is the outcome we want — the same technique
 * the ceremony notifier uses, and for the same reason.
 *
 * ⚠️ At-most-once. A failed DM is reported and NOT retried: the transition is
 * already written, so nothing would tell a later tick to try again, and
 * re-deriving that from state would re-DM every dormant faction on every tick
 * after any transient Discord failure. This is the opposite trade-off from
 * `notifyCompleted`, which sends before marking — and the reason differs. A
 * missed completion DM strands a player who did everything right; a missed
 * dormancy DM costs a leader a warning about a state they can see and reverse
 * at any time.
 */
export async function notifyDormancy(
  notices: DormancyNotice[],
  send: Sender,
  onError?: (n: DormancyNotice, err: unknown) => void,
): Promise<number> {
  let sent = 0;
  for (const n of notices) {
    try {
      await send({ discordId: n.leaderDiscordId, channelId: "", content: formatDormancyDm(n) });
      sent++;
    } catch (err) {
      onError?.(n, err);
    }
  }
  return sent;
}
