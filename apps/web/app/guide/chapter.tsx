import type { Metadata } from "next";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CONTENT_DIR, GUIDE_DESCRIPTION, hrefFor, neighbours, type Chapter } from "@/lib/guide";

export function chapterMetadata(c: Chapter): Metadata {
  return { title: `${c.number}. ${c.title} — DayZ Clan Wars Field Guide`, description: GUIDE_DESCRIPTION };
}

/**
 * One chapter: the opener from the manifest, the hand-written fragment, the
 * pager. ⚠️ The fragment is our own HTML from content/guide, read at build
 * time — not user input — which is the only reason dangerouslySetInnerHTML
 * is acceptable here.
 */
export default function ChapterPage({ chapter }: { chapter: Chapter }) {
  const html = readFileSync(join(CONTENT_DIR, chapter.file), "utf8");
  const { prev, next } = neighbours(chapter);
  return (
    <article className="page">
      <header className="opener"><span className="num">{chapter.number}</span><h1>{chapter.title}</h1><p className="lede">{chapter.lede}</p></header>
      <div dangerouslySetInnerHTML={{ __html: html }} />
      <nav className="pager" aria-label="Previous and next">
        {prev ? <a className="prev" href={hrefFor(prev)}><span className="lbl">&larr; Back</span><span className="dest">{prev.number}. {prev.title}</span></a> : <span className="prev empty" aria-hidden="true" />}
        {next ? <a className="next" href={hrefFor(next)}><span className="lbl">Next &rarr;</span><span className="dest">{next.number}. {next.title}</span></a> : <span className="next empty" aria-hidden="true" />}
      </nav>
      <footer className="site">DayZ Clan Wars · dayzclanwars.com</footer>
    </article>
  );
}
