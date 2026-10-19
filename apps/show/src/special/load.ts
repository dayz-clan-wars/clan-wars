import fs from "node:fs";
import path from "node:path";
import type { Card } from "../engine/animation/screenWall.js";

// A special is a hand-written, one-off episode (spec 2026-10-19-nasdara-promo-episode-design.md):
// a directory holding `script.txt`, `meta.json`, `intro.png` and `outro.png`. Everything is
// checked here, before any paid call (ElevenLabs, OpenRouter) or any publish.

export type SpecialMeta = {
  slug: string;
  code: "Special";
  subtitle: string;
  /** The YouTube description's head, before the transcript. */
  descriptionLead: string;
  /** Facebook caption lines, before the YouTube link and the invite. */
  facebookLines: string[];
  cards: Card[];
  marquee: string[];
  /** Words sent through the pronouncer (Nasdara place names); may be empty. */
  pronounce: string[];
};
export type Special = SpecialMeta & { dir: string; narrative: string; introPath: string; outroPath: string };

/** About 2.5 minutes spoken, by the weekly prompt's 5,000-characters-is-four-minutes ratio. */
export const SPECIAL_SCRIPT_MAX = 3300;

type LoadFs = { readFileSync: (p: string, enc: "utf8") => string; existsSync: (p: string) => boolean };

const DIALOGUE = /^(Boris|Pavel): \S/u;

const isStrings = (v: unknown): v is string[] => Array.isArray(v) && v.every((s) => typeof s === "string");
const isCard = (c: any): c is Card =>
  c && typeof c.header === "string" && typeof c.title === "string" &&
  Array.isArray(c.rows) && c.rows.every((r: any) => r && typeof r.name === "string" && typeof r.value === "string");

function parseMeta(raw: unknown): SpecialMeta {
  const m = raw as Record<string, unknown>;
  const bad = (field: string) => new Error(`special meta.json: bad or missing "${field}"`);
  if (!m || typeof m !== "object") throw new Error("special meta.json: not an object");
  if (typeof m.slug !== "string" || !/^[a-z0-9-]+$/u.test(m.slug)) throw bad("slug");
  // ⚠️ The code goes into the YouTube title and the forum thread name; anything but "Special"
  // could collide with a weekly episode's S01Exx on the shared channel.
  if (m.code !== "Special") throw bad("code");
  if (typeof m.subtitle !== "string" || !m.subtitle.trim()) throw bad("subtitle");
  if (typeof m.descriptionLead !== "string") throw bad("descriptionLead");
  if (!isStrings(m.facebookLines)) throw bad("facebookLines");
  if (!Array.isArray(m.cards) || !m.cards.length || !m.cards.every(isCard)) throw bad("cards");
  if (!isStrings(m.marquee) || !m.marquee.length) throw bad("marquee");
  if (!isStrings(m.pronounce)) throw bad("pronounce");
  return m as unknown as SpecialMeta;
}

export function loadSpecial(dir: string, fsImpl: LoadFs = fs): Special {
  const narrative = fsImpl.readFileSync(path.join(dir, "script.txt"), "utf8").trim();
  for (const line of narrative.split("\n").map((l) => l.trim()).filter(Boolean)) {
    // ⚠️ parseDialogue would silently glue a stray line onto the previous turn, so a stage
    // direction would be voiced; refuse it here instead.
    if (!DIALOGUE.test(line)) throw new Error(`special script: not a dialogue line: ${line.slice(0, 60)}`);
  }
  if (/[–—]/u.test(narrative)) throw new Error("special script: contains an em or en dash");
  if (narrative.length > SPECIAL_SCRIPT_MAX) {
    throw new Error(`special script: ${narrative.length} characters, cap is ${SPECIAL_SCRIPT_MAX}`);
  }
  const meta = parseMeta(JSON.parse(fsImpl.readFileSync(path.join(dir, "meta.json"), "utf8")));
  const introPath = path.join(dir, "intro.png");
  const outroPath = path.join(dir, "outro.png");
  for (const p of [introPath, outroPath]) if (!fsImpl.existsSync(p)) throw new Error(`special: missing ${path.basename(p)} in ${dir}`);
  return { ...meta, dir, narrative, introPath, outroPath };
}
