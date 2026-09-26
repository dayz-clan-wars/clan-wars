import { buildShowPrompt } from "../prompt/build.js";
import { EpisodeParseError, parseEpisode } from "../prompt/parse.js";
import { blocklistHit } from "../screening/blocklist.js";
import type { Moderate } from "../screening/moderate.js";
import { escapeRe } from "../screening/redact.js";
import type { Storyline, StoryContext } from "../story/types.js";

export const MAX_SCRIPT_ATTEMPTS = 2;
export const MAX_TRIMS = 2;
export const TRIM_TARGET_CHARS = 4800;

export type Generate = (system: string, user: string) => Promise<string>;

export type ScriptResult =
  | { ok: true; narrative: string; title: string; storylines: Storyline[]; attempts: number; reasons: string[] }
  | { ok: false; reasons: string[]; attempts: number };

/**
 * The output screen (spec §7.2), over the whole script plus its title and storylines.
 * Returns why it failed, or [] when it passed. A moderator error propagates: screening
 * that did not run is not screening that passed.
 */
export async function screenScript(text: string, blocked: string[], moderate: Moderate, allowed: string[] = []): Promise<string[]> {
  const word = (s: string, flags: string) => new RegExp(`(?<![A-Za-z0-9])${escapeRe(s)}(?![A-Za-z0-9])`, flags);
  // An operator-allowed text (spec §7.4) would otherwise trip the blocklist every week.
  // Masked for the deterministic checks only: the moderator still reads the real text.
  const masked = [...allowed].sort((a, b) => b.length - a.length).reduce((acc, a) => acc.replace(word(a, "giu"), "X"), text);
  const hit = blocklistHit(masked);
  if (hit !== null) return [`blocklist: ${hit}`];
  // Whole words only, any case (as redact.ts's inProse): "SS" must not fail "boss".
  const surfaced = blocked.find((b) => word(b, "iu").test(masked));
  if (surfaced !== undefined) return [`blocked text: "${surfaced}"`];
  const [verdict] = await moderate([text]);
  return verdict!.block ? [`moderation: ${verdict!.reason || "blocked"}`] : [];
}

/**
 * Generate, parse and screen, with one regenerate (spec §7.2, §8.3). `{ ok: false }` is
 * the `held` outcome: nothing from it may be voiced or published.
 *
 * Both outcomes carry `reasons`: every failure recorded before the run ended, so a
 * dry run that only succeeded on attempt 2 still shows why attempt 1 failed instead of
 * hiding it behind a bare `ok: true`. Empty when the very first attempt passed.
 *
 * A model reply that parses as over the character cap gets up to MAX_TRIMS trim calls
 * within the same attempt, before the attempt counts as failed: the latest too-long
 * reply is handed back with an instruction to cut it under TRIM_TARGET_CHARS, keeping
 * every storyline and the format. A trimmed reply that parses is screened exactly like a
 * first draft. ⚠️ The target sits well under the 6,000 cap because the model overshoots
 * it: a busy week's trims came back at 6,279 and 6,648 against a 5,500 target (S01E02,
 * held twice on length alone).
 */
export async function writeScript(context: StoryContext, blocked: string[], deps: { generate: Generate; moderate: Moderate; allowed?: string[] }): Promise<ScriptResult> {
  const { system, user } = buildShowPrompt(context);
  const reasons: string[] = [];
  for (let attempt = 1; attempt <= MAX_SCRIPT_ATTEMPTS; attempt++) {
    const raw = await deps.generate(system, user);
    let parsed;
    try {
      parsed = parseEpisode(raw);
    } catch (err) {
      if (!(err instanceof EpisodeParseError)) throw err;
      reasons.push(`attempt ${attempt}: ${err.message}`);
      if (err.reason !== "too_long") continue;
      let longRaw = raw;
      let longLength = err.length;
      for (let trim = 1; trim <= MAX_TRIMS && parsed === undefined; trim++) {
        const trimUser = `${user}\n\nYour script below is ${longLength} characters. Cut it to under ${TRIM_TARGET_CHARS.toLocaleString("en-US")} characters: drop the weakest jokes and lines, keep every storyline and the format (dialogue lines, then the ===STORYLINES=== line and its JSON). Return the whole episode.\n\n${longRaw}`;
        const trimmedRaw = await deps.generate(system, trimUser);
        try {
          parsed = parseEpisode(trimmedRaw);
        } catch (err2) {
          if (!(err2 instanceof EpisodeParseError)) throw err2;
          reasons.push(`attempt ${attempt} (trimmed${trim > 1 ? ` ${trim}` : ""}): ${err2.message}`);
          if (err2.reason !== "too_long") break;
          longRaw = trimmedRaw;
          longLength = err2.length;
        }
      }
      if (parsed === undefined) continue;
    }
    const screened = [parsed.narrative, parsed.title, ...parsed.storylines.flatMap((s) => [s.title, s.status, ...s.players, ...s.clans, ...s.openQuestions])].join("\n");
    const failed = await screenScript(screened, blocked, deps.moderate, deps.allowed);
    if (failed.length === 0) return { ok: true, ...parsed, attempts: attempt, reasons: [...reasons] };
    reasons.push(...failed.map((f) => `attempt ${attempt}: ${f}`));
  }
  return { ok: false, reasons, attempts: MAX_SCRIPT_ATTEMPTS };
}
