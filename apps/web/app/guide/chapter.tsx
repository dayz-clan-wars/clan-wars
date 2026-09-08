import type { Metadata } from "next";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { GUIDE_GROUPS, GUIDE_NUMBERS } from "@factions/domain";
import { CONTENT_DIR, GUIDE_DESCRIPTION, hrefFor, neighbours, type Chapter } from "@/lib/guide";
import { renderFragment } from "./render";
import { Anchors } from "./anchors";

export function chapterMetadata(c: Chapter): Metadata {
  return { title: `${c.number}. ${c.title} — DayZ Clan Wars Field Guide`, description: GUIDE_DESCRIPTION };
}

/** A chapter's fragment, rendered: tokens substituted, headings anchored. Read at build time. */
export function chapterHtml(c: Chapter): ReturnType<typeof renderFragment> | null {
  if (c.file === null) return null;
  return renderFragment(readFileSync(join(CONTENT_DIR, c.file), "utf8"));
}

/**
 * One chapter on the site's primitives: the opener (numeral, uppercase
 * title, lede), the fragment inside `.prose-guide` (the one place the guide
 * keeps its own CSS), the pager, the footer line. The appendix has no
 * fragment; it renders GUIDE_NUMBERS.
 *
 * ⚠️ The fragment is our own HTML from content/guide, read at build time —
 * not user input — which is the only reason dangerouslySetInnerHTML is
 * acceptable here.
 */
export default function ChapterPage({ chapter }: { chapter: Chapter }) {
  const rendered = chapterHtml(chapter);
  const { prev, next } = neighbours(chapter);
  return (
    <article className="max-w-[calc(66ch+128px)] px-5 pb-10 pt-8 lg:px-16 lg:pb-16 lg:pt-14">
      <header className="mb-7 flex flex-col gap-5">
        <div className="flex items-baseline gap-3.5 lg:gap-5">
          <span className="font-display text-[64px] leading-[.8] tracking-[-0.02em] text-gold lg:text-[96px]">{chapter.number}</span>
          <h1 className="m-0 font-display text-[40px] uppercase leading-[.9] tracking-[-0.02em] text-ink lg:text-[56px]">{chapter.title}</h1>
        </div>
        <p className="m-0 max-w-[56ch] text-lg leading-[1.45] text-ink-2 [text-wrap:pretty] lg:text-xl">{chapter.lede}</p>
      </header>

      {rendered ? <div className="prose-guide" dangerouslySetInnerHTML={{ __html: rendered.html }} /> : <Appendix />}
      <Anchors />

      <nav className="mt-10 grid max-w-[66ch] grid-cols-2 border-2 border-rule-2 lg:mt-14" aria-label="Previous and next">
        {prev ? (
          <a className="block min-h-[72px] border-r border-rule-2 px-4 py-3.5 text-ink hover:bg-frame lg:px-5 lg:py-4" href={hrefFor(prev)}>
            <span className="block font-mono text-[10px] uppercase tracking-[0.18em] text-muted">&larr; Back</span>
            <span className="mt-1.5 block font-display text-sm lg:text-[15px]">{prev.number}. {prev.title}</span>
          </a>
        ) : <span className="min-h-[72px] border-r border-rule-2" aria-hidden="true" />}
        {next ? (
          <a className="block min-h-[72px] px-4 py-3.5 text-right text-ink hover:bg-frame lg:px-5 lg:py-4" href={hrefFor(next)}>
            <span className="block font-mono text-[10px] uppercase tracking-[0.18em] text-gold">Next &rarr;</span>
            <span className="mt-1.5 block font-display text-sm lg:text-[15px]">{next.number}. {next.title}</span>
          </a>
        ) : <span className="min-h-[72px]" aria-hidden="true" />}
      </nav>
      <footer className="mt-10 max-w-[66ch] font-mono text-[11px] text-dim">DayZ Clan Wars · dayzclanwars.com</footer>
    </article>
  );
}

/** The "Every number" table, from packages/domain — the same source the chapters' tokens read. */
function Appendix() {
  return (
    <div className="prose-guide">
      <p>Every timer, cap, radius and cooldown in the guide, in one place. Each one is read from the same rule the server enforces, so this table and the chapters cannot disagree.</p>
      <div className="tablewrap">
        <table>
          <tbody>
            {GUIDE_GROUPS.map((g) => (
              <GroupRows key={g} group={g} />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function GroupRows({ group }: { group: string }) {
  const rows = GUIDE_NUMBERS.filter((r) => r.group === group);
  return (
    <>
      <tr className="group"><td colSpan={2}>{group}</td></tr>
      {rows.map((r) => (
        <tr key={r.key}><td>{r.label}</td><td className="v">{r.value}</td></tr>
      ))}
    </>
  );
}
