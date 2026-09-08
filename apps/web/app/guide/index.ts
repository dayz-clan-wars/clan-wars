import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CHAPTERS, CONTENT_DIR, hrefFor } from "@/lib/guide";
import { renderFragment } from "./render";

/**
 * The guide's search index: one entry per chapter and one per section, with
 * the first sentence beneath the heading as a hint. Built on the server from
 * the fragments (the same render pass the pages use, so ids agree) and
 * handed to GuideSearch as props. A few kilobytes; no route, no server search.
 */
/** `body`: the whole section's text, matched but never shown. Only the guide's own search carries it; the site drawer gets the light index. */
export type SearchEntry = { chapter: string; number: string; href: string; heading?: string; text: string; body?: string };

const strip = (html: string) => html.replace(/<[^>]+>/gu, "").replace(/\s+/gu, " ").replace(/&rsquo;|&#8217;/gu, "’").replace(/&amp;/gu, "&").trim();

/** The text of the first <p> or <li> after `from`, cut at ~160 characters. */
function firstText(html: string, from: number): string {
  const rest = html.slice(from);
  const m = /<(?:p|li)[^>]*>([\s\S]*?)<\/(?:p|li)>/u.exec(rest);
  const t = m ? strip(m[1]!) : "";
  return t.length > 160 ? `${t.slice(0, 157).trimEnd()}…` : t;
}

/**
 * `full` adds each section's whole text (and, for the chapter entry, the text
 * before its first heading) as `body`, so "watch zone" finds the glossary
 * line that defines it, not just a heading that names it. ~60 KB across the
 * guide — fine for the guide's own pages, too much to ship with every site
 * page, which is why the drawer asks for the light index.
 */
export function buildIndex(full = false): SearchEntry[] {
  const out: SearchEntry[] = [];
  for (const c of CHAPTERS) {
    if (c.file === null) { out.push({ chapter: c.title, number: c.number, href: hrefFor(c), text: c.lede }); continue; }
    const { html, headings } = renderFragment(readFileSync(join(CONTENT_DIR, c.file), "utf8"));
    const cuts = headings.map((h) => html.indexOf(`<h2 id="${h.id}"`));
    const section = (i: number) => strip(html.slice(i < 0 ? 0 : cuts[i]!, i + 1 < cuts.length ? cuts[i + 1] : undefined));
    out.push({ chapter: c.title, number: c.number, href: hrefFor(c), text: c.lede, ...(full ? { body: strip(html.slice(0, cuts[0] ?? undefined)) } : {}) });
    headings.forEach((h, i) => {
      out.push({ chapter: c.title, number: c.number, href: `${hrefFor(c)}#${h.id}`, heading: h.text, text: firstText(html, cuts[i]!), ...(full ? { body: section(i) } : {}) });
    });
  }
  return out;
}
