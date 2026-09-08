"use client";
import { usePathname } from "next/navigation";
import { CHAPTERS, hrefFor } from "@/lib/guide";

/**
 * The chapter list, twice per page (rail and top-bar menu). Client-side only
 * for `aria-current`: the layout is shared by every chapter and cannot know
 * which one is showing without the pathname.
 *
 * The old markup put the separator before the appendix in its own <li>;
 * rendering it inside the appendix's <li> keeps the list valid and the CSS
 * unchanged (`.toc .sep` only sets a border and margins).
 */
export default function Contents() {
  const here = usePathname();
  return (
    <nav aria-label="Chapters">
      <ul className="toc">
        {CHAPTERS.map((c) => (
          <li key={c.file}>
            {c.slug === "numbers" && <span className="sep" aria-hidden="true" style={{ display: "block" }} />}
            <a href={hrefFor(c)} aria-current={hrefFor(c) === here ? "page" : undefined}>
              <span className="n">{c.number}</span>
              <span>{c.title}</span>
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}
