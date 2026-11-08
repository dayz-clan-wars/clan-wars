import { RAID_HEAT, RAID_HEAT_FADE_MS, RAID_HIT_FADE_MS } from "@factions/domain";
import { days } from "./format";

type Value = string | number | boolean | null | undefined;

/**
 * The `raid_scored` notice's sentences (2026-11-08), shared by the bot's
 * Discord text and the site's notification copy so the two cannot explain
 * the same raid two ways.
 *
 * ⚠️ Every surface-specific piece comes in through `fmt`: names already
 * rendered (a profile link in Discord, plain text on the site), a date
 * formatter (a `<t:…>` token in Discord, a plain date on the site) and
 * `bold`. A Discord token typed in here would print as noise on the site
 * (`no-discord-tokens.test.ts`).
 *
 * The payload is the one `queueRaidScored` in apps/bot/src/raid-tick.ts
 * froze at the raid. A missing number renders as a word, never as NaN.
 */
export type RaidScoredView = { title: string; scoring: string; yourValue: string | null; theirValue: string };

export function raidScoredCopy(
  p: Record<string, Value>,
  fmt: { lowerer: string; victim: string; date: (iso: Value) => string | null; bold: (s: string) => string },
): RaidScoredView {
  const n = (v: Value): string => (typeof v === "number" && Number.isFinite(v) ? String(v) : "?");
  const b = fmt.bold;
  const points = typeof p.points === "number" ? p.points : 0;
  const pts = (x: number) => `${x} ${x === 1 ? "point" : "points"}`;
  const active = p.raiderStatus === "active";

  const title = active
    ? `${fmt.lowerer} raided ${fmt.victim} for ${b(pts(points))}.`
    : `${fmt.lowerer} raided ${fmt.victim}. ${b("No points")}: ${p.raiderStatus === "dormant" ? "your clan is dormant" : "your clan isn't active yet"}, and only active clans score.`;

  // How the victim's price was built, then what the raid paid from it.
  let scoring: string;
  const victimNew = fmt.date(p.victimNewUntil);
  if (p.victimNewUntil) {
    scoring = `They're a new clan, so they're worth 0${victimNew ? ` until ${victimNew}` : " for now"} and the raid pays nothing. It still counts as a raid you landed.`;
  } else {
    const heat = typeof p.victimHeat === "number" ? p.victimHeat : 0;
    const hitPct = typeof p.victimHitPct === "number" ? p.victimHitPct : 100;
    const parts = [`base ${n(p.victimBase)}`];
    if (heat > 0) parts.push(`+${heat} heat from raids they've landed lately`);
    if (hitPct < 100) parts.push(`then cut to ${hitPct}% because they were raided recently`);
    const priced = `They were worth ${b(n(p.victimValue))}: ${parts.join(", ")}.`;
    const mult = n(p.mult);
    const who = p.online === true ? "Someone from their clan was online" : "Nobody from their clan was online";
    const paid = active
      ? `${who}, so the raid pays ×${mult}: ${n(p.victimValue)} × ${mult} = ${b(pts(points))}.`
      : `${who}, so the raid pays ×${mult}. An active clan would have scored ${pts(typeof p.fullPrice === "number" ? p.fullPrice : 0)}.`;
    scoring = `${priced} ${paid}`;
  }

  const fade = days(RAID_HEAT_FADE_MS);
  let yourValue: string | null;
  if (p.raiderValueAfter === null || p.raiderValueAfter === undefined) {
    // A reserved clan has never activated, so it has no value yet.
    yourValue = "Raise your flag at your pole to activate. Raids you land before then still add heat to your value.";
  } else if (p.raiderNewUntil) {
    const until = fmt.date(p.raiderNewUntil);
    yourValue = `Your value is 0${until ? ` until ${until}` : " for now"}, while you're a new clan. This raid adds +${RAID_HEAT} heat, fading over ${fade}, so you'll be worth more when you start counting.`;
  } else {
    yourValue = `Your value went from ${n(p.raiderValueBefore)} to ${b(n(p.raiderValueAfter))}. Every raid you land adds +${RAID_HEAT}, fading over ${fade}.`;
    if (!active && p.raiderStatus === "dormant") {
      yourValue += ` Nobody can raid you while you're dormant. Raise your flag and you're back on the board at your new price.`;
    }
  }

  const theirValue = p.victimNewUntil
    ? "Their value stays 0 until they stop being a new clan."
    : `Their value dropped from ${n(p.victimValue)} to ${n(p.victimValueAfter)}. Being raided halves a clan's value, and it recovers over ${days(RAID_HIT_FADE_MS)}.`;

  return { title, scoring, yourValue, theirValue };
}
