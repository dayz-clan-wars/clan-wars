import { parseJsonObject } from "../engine/llm/openrouter.js";
import type { Storyline } from "../story/types.js";
import { STORYLINES_MARKER } from "./system.js";

export { STORYLINES_MARKER };
export const MAX_NARRATIVE_CHARS = 6000;
export const MAX_TITLE_CHARS = 40;
const MIN_LINES = 10;
/**
 * ⚠️ FORMAT asks for 2 or 3 storylines, but the model sometimes lists side segments
 * too — and this JSON feeds next week's "Previously on", so it must hold only the
 * main storylines. A regenerate is not worth spending on this: keep the first
 * MAX_STORYLINES and drop the rest rather than throwing.
 */
export const MAX_STORYLINES = 3;

export class EpisodeParseError extends Error {
  readonly reason: "too_long" | "format";
  readonly length?: number;

  constructor(message: string, reason: "too_long" | "format" = "format", length?: number) {
    super(message);
    this.reason = reason;
    this.length = length;
  }
}

export type ParsedEpisode = { narrative: string; title: string; storylines: Storyline[] };

/**
 * The show never airs an em dash (spec \u00a72.3). Deterministic, so no regenerate is spent on it.
 *
 * Collapses a whole run of em dashes (with any whitespace between them, e.g. "\u2014\u2014" or
 * "\u2014 \u2014") into a single ", ", then cleans up the three places that comma must never land:
 * the very start of the string, the start of a line, and right after a speaker's colon.
 */
export function normalizeDashes(s: string): string {
  return s
    .replace(/\s*(?:\u2014\s*)+/gu, ", ")
    .replace(/:\s*,\s*/gu, ": ")
    .replace(/(^|\n)\s*,\s*/gu, "$1")
    .replace(/,\s*([.!?])/gu, "$1");
}

const SPEAKER = /^(?:[-*\u2022]\s+)?\*{0,2}(boris|pavel)\*{0,2}:\*{0,2}\s*/iu;
const isStringArray = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string");

/**
 * The model's reply \u2192 dialogue and storylines (spec \u00a76.3). Anything off-format throws
 * `EpisodeParseError`, which the script stage counts as a failed attempt.
 *
 * ⚠️ Splits on the LAST marker: a clan pitch quoted on air can contain the marker text.
 */
export function parseEpisode(raw: string): ParsedEpisode {
  const cut = raw.lastIndexOf(STORYLINES_MARKER);
  if (cut < 0) throw new EpisodeParseError(`no ${STORYLINES_MARKER} block`);

  const lines = raw.slice(0, cut).split(/\r?\n/u).map((l) => l.trim()).filter((l) => l !== "")
    .map((l) => l.replace(SPEAKER, (_m, who: string) => `${who[0]!.toUpperCase()}${who.slice(1).toLowerCase()}: `));
  const bad = lines.find((l) => !/^(Boris|Pavel): \S/u.test(l));
  if (bad !== undefined) throw new EpisodeParseError(`not a dialogue line: ${bad.slice(0, 80)}`);
  if (lines.length < MIN_LINES) throw new EpisodeParseError(`only ${lines.length} lines of dialogue`);
  const narrative = normalizeDashes(lines.join("\n"));
  if (narrative.length > MAX_NARRATIVE_CHARS) {
    throw new EpisodeParseError(`script is ${narrative.length} characters, cap is ${MAX_NARRATIVE_CHARS}`, "too_long", narrative.length);
  }

  let parsed: unknown;
  try { parsed = parseJsonObject(raw.slice(cut + STORYLINES_MARKER.length)); } catch { throw new EpisodeParseError("storylines block is not JSON"); }
  const o = parsed as { title?: unknown; storylines?: unknown };
  if (typeof o.title !== "string" || o.title.trim() === "") throw new EpisodeParseError("storylines block has no title");
  const title = normalizeDashes(o.title.trim());
  if (title.length > MAX_TITLE_CHARS) throw new EpisodeParseError(`title is ${title.length} characters, cap is ${MAX_TITLE_CHARS}`);
  if (!Array.isArray(o.storylines) || o.storylines.length === 0) throw new EpisodeParseError("storylines block lists no storylines");

  const storylines = o.storylines.slice(0, MAX_STORYLINES).map((s, i): Storyline => {
    const x = s as Partial<Record<keyof Storyline, unknown>>;
    if (typeof x.title !== "string" || typeof x.status !== "string" || !isStringArray(x.players) || !isStringArray(x.clans) || !isStringArray(x.openQuestions)) {
      throw new EpisodeParseError(`storyline ${i} is malformed`);
    }
    return {
      title: normalizeDashes(x.title), players: x.players.map(normalizeDashes), clans: x.clans.map(normalizeDashes),
      status: normalizeDashes(x.status), openQuestions: x.openQuestions.map(normalizeDashes),
    };
  });
  return { narrative, title, storylines };
}
