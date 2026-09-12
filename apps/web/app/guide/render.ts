import { ACHIEVEMENTS, ACHIEVEMENT_GROUPS, guideNumber, type Format } from "@factions/domain";
import { GROUP_LABELS } from "@/lib/achievements-copy";

/**
 * One pass over a chapter fragment before it is injected:
 *
 * 1. `{{KEY}}` / `{{KEY|format}}` tokens become the number rules.ts states
 *    (packages/domain/src/guide-numbers.ts). ⚠️ An unknown key or a
 *    misfitting format THROWS — at build time for the static chapters — so a
 *    typo can never ship as literal braces.
 * 2. Every `<h2>` gets an id from its text and a trailing anchor link, so a
 *    section can be linked to and the search index can point into it.
 *
 * Returns the HTML and the headings, in order, for the index and the
 * cross-link test.
 */
export type Heading = { id: string; text: string };

const TOKEN = /\{\{\s*([A-Z0-9_]+)\s*(?:\|\s*([a-z]+)\s*)?\}\}/gu;
const H2 = /<h2>([\s\S]*?)<\/h2>/gu;
const FORMATS: readonly Format[] = ["days", "hours", "minutes", "h", "min", "m", "n"];

const ACHIEVEMENTS_TOKEN = "{{ACHIEVEMENTS}}";

/** `&`/`<`/`>` only — achievement names and descriptions are our own copy, not user input, but the table is generated so nothing should ever be trusted to already be safe HTML. */
function escape(s: string): string {
  return s.replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;");
}

/**
 * The fifty achievements, rendered from `@factions/domain`'s `ACHIEVEMENTS` —
 * never typed here, so a threshold or a new achievement in rules.ts shows up
 * in the guide without an edit. One table, grouped exactly the way the
 * appendix groups `GUIDE_NUMBERS` (a `tr.group` divider row, plain `<table>`
 * inside `.tablewrap` — the same CSS the "Every number" table rides on, and
 * the same shape guide-discord.ts's table parser already understands).
 */
export function achievementsTable(): string {
  const row = (a: (typeof ACHIEVEMENTS)[number]) => `<tr><td>${escape(a.name)}</td><td>${escape(a.description)}</td></tr>`;
  const groupRows = (g: (typeof ACHIEVEMENT_GROUPS)[number]) =>
    `<tr class="group"><td colspan="2">${escape(GROUP_LABELS[g])}</td></tr>` +
    ACHIEVEMENTS.filter((a) => a.group === g).map(row).join("");
  return `<div class="tablewrap"><table><tbody>${ACHIEVEMENT_GROUPS.map(groupRows).join("")}</tbody></table></div>`;
}

/**
 * `{{ACHIEVEMENTS}}` is a block token, not a `{{KEY|format}}` number token —
 * it must be gone before `substituteTokens` runs, because `TOKEN`'s
 * `[A-Z0-9_]+` would otherwise match it and `guideNumber` would throw on the
 * unknown key. guide-discord.ts renders the same fragments through
 * `substituteTokens` directly (not `renderFragment`), so it calls this too.
 */
export function replaceAchievementsToken(html: string): string {
  return html.includes(ACHIEVEMENTS_TOKEN) ? html.replace(ACHIEVEMENTS_TOKEN, achievementsTable()) : html;
}

export function slugify(text: string): string {
  return text
    .replace(/<[^>]+>/gu, "")
    .replace(/&[a-z]+;|&#\d+;/gu, " ")
    .toLowerCase()
    .replace(/[’'"“”]/gu, "")
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "");
}

export function substituteTokens(html: string): string {
  return replaceAchievementsToken(html).replace(TOKEN, (_, key: string, format?: string) => {
    if (format !== undefined && !(FORMATS as readonly string[]).includes(format)) throw new Error(`guide token {{${key}|${format}}}: unknown format`);
    return guideNumber(key, format as Format | undefined);
  });
}

export function renderFragment(html: string): { html: string; headings: Heading[] } {
  const headings: Heading[] = [];
  const seen = new Map<string, number>();
  const out = substituteTokens(html).replace(H2, (_, inner: string) => {
    const base = slugify(inner) || "section";
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    const id = n === 1 ? base : `${base}-${n}`;
    headings.push({ id, text: inner.replace(/<[^>]+>/gu, "").trim() });
    return `<h2 id="${id}">${inner}<a class="anchor" href="#${id}" aria-label="Link to this section">#</a></h2>`;
  });
  return { html: out, headings };
}
