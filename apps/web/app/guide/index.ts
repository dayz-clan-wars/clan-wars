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
export type SearchEntry = { chapter: string; number: string; href: string; heading?: string; text: string };

const strip = (html: string) => html.replace(/<[^>]+>/gu, "").replace(/\s+/gu, " ").replace(/&rsquo;|&#8217;/gu, "’").replace(/&amp;/gu, "&").trim();

/** The text of the first <p> or <li> after `from`, cut at ~160 characters. */
function firstText(html: string, from: number): string {
  const rest = html.slice(from);
  const m = /<(?:p|li)[^>]*>([\s\S]*?)<\/(?:p|li)>/u.exec(rest);
  const t = m ? strip(m[1]!) : "";
  return t.length > 160 ? `${t.slice(0, 157).trimEnd()}…` : t;
}

export function buildIndex(): SearchEntry[] {
  const out: SearchEntry[] = [];
  for (const c of CHAPTERS) {
    out.push({ chapter: c.title, number: c.number, href: hrefFor(c), text: c.lede });
    if (c.file === null) continue;
    const { html, headings } = renderFragment(readFileSync(join(CONTENT_DIR, c.file), "utf8"));
    for (const h of headings) {
      const at = html.indexOf(`id="${h.id}"`);
      out.push({ chapter: c.title, number: c.number, href: `${hrefFor(c)}#${h.id}`, heading: h.text, text: firstText(html, at) });
    }
  }
  return out;
}
