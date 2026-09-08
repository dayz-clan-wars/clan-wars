"use client";
import { usePathname } from "next/navigation";
import { CHAPTERS, hrefFor } from "@/lib/guide";

/**
 * The chapter list, in the rail and in the phone Contents menu. Client-side
 * only for `aria-current`: the layout is shared by every chapter and cannot
 * know which one is showing without the pathname.
 */
export default function Contents() {
  const here = usePathname();
  return (
    <nav aria-label="Chapters">
      <ol className="m-0 list-none p-0 text-sm">
        {CHAPTERS.map((c) => {
          const on = hrefFor(c) === here;
          return (
            <li key={c.slug} className={c.slug === "numbers" ? "mt-2 border-t border-rule-2 pt-2" : ""}>
              <a href={hrefFor(c)} aria-current={on ? "page" : undefined}
                className={`flex min-h-[44px] items-center gap-3.5 px-6 no-underline ${on ? "bg-gold font-display text-ground" : "text-ink hover:text-gold"}`}>
                <span className={`w-4 flex-none font-mono text-[11px] ${on ? "text-ground" : "text-muted"}`}>{c.number}</span>
                {c.title}
              </a>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
