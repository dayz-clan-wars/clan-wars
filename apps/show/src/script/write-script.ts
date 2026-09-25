import { buildShowPrompt } from "../prompt/build.js";
import { EpisodeParseError, parseEpisode } from "../prompt/parse.js";
import { blocklistHit } from "../screening/blocklist.js";
import type { Moderate } from "../screening/moderate.js";
import { escapeRe } from "../screening/redact.js";
import type { Storyline, StoryContext } from "../story/types.js";

export const MAX_SCRIPT_ATTEMPTS = 2;

export type Generate = (system: string, user: string) => Promise<string>;

export type ScriptResult =
  | { ok: true; narrative: string; title: string; storylines: Storyline[]; attempts: number }
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
      continue;
    }
    const screened = [parsed.narrative, parsed.title, ...parsed.storylines.flatMap((s) => [s.title, s.status, ...s.players, ...s.clans, ...s.openQuestions])].join("\n");
    const failed = await screenScript(screened, blocked, deps.moderate, deps.allowed);
    if (failed.length === 0) return { ok: true, ...parsed, attempts: attempt };
    reasons.push(...failed.map((f) => `attempt ${attempt}: ${f}`));
  }
  return { ok: false, reasons, attempts: MAX_SCRIPT_ATTEMPTS };
}
