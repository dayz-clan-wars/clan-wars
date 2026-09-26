import type { Generate } from "./write-script.js";

export type FactError = { line: string; problem: string };

/**
 * ⚠️ Prompt rules alone kept failing: S01E01 swapped a killer and victim, S01E02 miscounted
 * SNA's friendly fire, then (once that was fixed) reversed The Admins-vs-SNA kill counts and
 * gave RonaldRaygun552 "the two longest shots" when GoldSkull588's was longer. Every script
 * is now read back against the same data it was written from, by a separate call that only
 * looks for contradictions.
 *
 * ⚠️ The first version held S01E01 over nitpicks ("Wednesday night" for 6:11 pm, 19 minutes
 * for 20) alongside the real errors; the tolerances below are what it may let pass.
 */
export const FACT_CHECK_SYSTEM = `You fact-check a comedy sports-desk script about a DayZ server against the week's data, which is the JSON after "Write this week's episode from this data:".

Report every factual claim in the script that the data contradicts or does not support:
- who killed whom, and how many times: the killer and the victim must match the data exactly, never reversed. Read passive lines with care: "A was killed by B 17 times" means B killed A 17 times, so it is only right if the data has B as the killer. Check every such line against the "what" sentences in friendlyFire, clanBeefs and longestShots;
- numbers of kills, deaths, raids, points, members, metres, minutes and hours, and which player or clan each belongs to;
- rankings and superlatives such as longest, most, top, first, only, second: check them against every entry in the data, not just the one mentioned;
- which clan a player belongs to, joined or left, and when events happened;
- totals: a total is only right if the data states it;
- place names: the server is on the Livonia map, so any mention of Chernarus or a Chernarus town (Elektrozavodsk, Chernogorsk, Berezino and so on) is wrong, even inside Boris's stories.

Only report a claim you are sure is wrong. Never list a claim you checked and found correct, and never report these, which are fine:
- a time of day said loosely: "night", "evening" or "morning" for a time within a couple of hours of it, and "just before" or "just after" for a time within half an hour;
- a count of minutes or hours within about ten percent of the data, or rounded the way people speak;
- founding a clan and raising its flag told as one moment, when the data has them on the same day.

These are not claims and must never be reported: jokes, insults, opinions, predictions, questions, the hosts' banter about each other, and Boris's stories about his own past (apart from where they are set). Rounding a number the way people speak it is fine. A claim the data does not mention at all counts as unsupported only when it is about a player, clan or event of this server.

Reply with JSON only, no other text:
{"errors":[{"line":"<the script line, copied exactly>","problem":"<one sentence: what is wrong, and what the data actually says>"}]}
Reply {"errors":[]} when every claim holds.`;

export class FactCheckError extends Error {}

/** The claims in `narrative` that contradict `data` (the user message the script was written from). */
export async function factCheck(narrative: string, data: string, generate: Generate): Promise<FactError[]> {
  const raw = await generate(FACT_CHECK_SYSTEM, `${data}\n\nThe script to check:\n${narrative}`);
  // The checker may think aloud before its JSON; the answer is the last errors object.
  const start = raw.lastIndexOf('{"errors"') >= 0 ? raw.lastIndexOf('{"errors"') : raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.slice(start, end + 1));
  } catch {
    throw new FactCheckError("fact check reply was not JSON");
  }
  const errors = (parsed as { errors?: unknown })?.errors;
  if (start < 0 || !Array.isArray(errors)) throw new FactCheckError("fact check reply had no errors list");
  return errors
    .filter((e): e is FactError => typeof e?.line === "string" && typeof e?.problem === "string")
    // ⚠️ The checker sometimes lists a claim it then clears ("This is correct. No error here.").
    .filter((e) => !/\bno error\b/iu.test(e.problem))
    .map((e) => ({ line: e.line, problem: e.problem }));
}
