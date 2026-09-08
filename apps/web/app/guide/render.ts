import { guideNumber, type Format } from "@factions/domain";

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
  return html.replace(TOKEN, (_, key: string, format?: string) => {
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
