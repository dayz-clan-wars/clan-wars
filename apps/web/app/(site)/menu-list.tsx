"use client";
import { useEffect, useRef } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import { barFor, isCurrent, menuFor, signInHref } from "@/lib/menu";
import { GuideSearch } from "@/app/guide/search";
import type { SearchEntry } from "@/app/guide/index";

function useHere() {
  const pathname = usePathname();
  const search = useSearchParams().toString();
  return { pathname, here: search ? `${pathname}?${search}` : pathname };
}

/** The desktop bar's items. Client-side only to mark the current page and carry the path into Sign in. */
export function BarNav({ signedIn }: { signedIn: boolean }) {
  const { pathname, here } = useHere();
  const cell = "flex h-full items-center border-l border-rule-2 px-4 font-display text-xs uppercase tracking-[0.06em]";
  return (
    <nav aria-label="Site" className="flex h-full items-stretch whitespace-nowrap">
      {barFor(signedIn).map((group, gi) => (
        <div key={gi} className={`flex items-stretch ${gi > 0 ? "ml-4" : ""}`}>
          {group.map((m) => {
            const on = isCurrent(m, pathname);
            return (
              <a key={m.href} href={m.href} aria-current={on ? "page" : undefined}
                className={`${cell} ${on ? "text-gold shadow-[inset_0_-2px_0_var(--color-gold)]" : m.quiet ? "text-muted hover:text-ink" : "text-ink hover:text-gold"}`}>
                {m.label}
              </a>
            );
          })}
        </div>
      ))}
      {signedIn ? (
        // POST only: the logout route refuses GET (app/api/auth/logout/route.ts).
        <form action="/api/auth/logout" method="post" className="flex items-stretch border-l border-rule-2">
          <button type="submit" className="flex h-full items-center pl-5 font-mono text-[11px] uppercase tracking-[0.18em] text-muted hover:text-ink">Sign out</button>
        </form>
      ) : (
        <a href={signInHref(here)} className="ml-4 flex items-center bg-gold px-5 font-display text-xs uppercase tracking-[0.06em] text-ground hover:bg-gold-hover">Sign in</a>
      )}
    </nav>
  );
}

/**
 * The phone drawer: a <details> so it works without JavaScript and closes on
 * navigation; this adds Escape, click-outside, and the dimmed backdrop. The
 * summary reads "Menu" closed and "Close" open, filled gold when open.
 */
export function Drawer({ signedIn, guideIndex }: { signedIn: boolean; guideIndex?: SearchEntry[] }) {
  const { pathname, here } = useHere();
  const root = useRef<HTMLDetailsElement>(null);

  useEffect(() => {
    const details = root.current;
    if (!details) return;
    const close = () => details.removeAttribute("open");
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") close(); };
    const onClick = (e: MouseEvent) => { if (!details.contains(e.target as Node)) close(); };
    document.addEventListener("keydown", onKey);
    document.addEventListener("click", onClick);
    return () => { document.removeEventListener("keydown", onKey); document.removeEventListener("click", onClick); };
  }, []);

  const item = "flex min-h-[48px] items-center justify-between px-5 font-display text-sm uppercase tracking-[0.06em]";
  return (
    <details ref={root} className="group">
      <summary className="flex min-h-[44px] cursor-pointer list-none items-center border border-gold px-3 font-display text-xs uppercase tracking-[0.06em] text-gold group-open:bg-gold group-open:text-ground [&::-webkit-details-marker]:hidden">
        <span className="group-open:hidden">Menu</span><span className="hidden group-open:inline">Close</span>
      </summary>
      {/* The backdrop sits under the panel but over the page; a tap on it is a click outside the panel's <details>… except it IS inside. So it closes itself. */}
      <div className="fixed inset-x-0 bottom-0 top-bar z-[1290] bg-ground/70" onClick={() => root.current?.removeAttribute("open")} aria-hidden="true" />
      <nav aria-label="Site" className="absolute right-3 top-[60px] z-[1300] w-[300px] max-w-[calc(100vw-24px)] border-2 border-rule-2 bg-frame shadow-[0_16px_40px_rgba(0,0,0,.6)]">
        {guideIndex && <div className="border-b-2 border-rule-2 p-3"><GuideSearch index={guideIndex} compact /></div>}
        {menuFor(signedIn).map((group, gi) => (
          <ul key={gi} className={`py-2 ${gi > 0 ? "border-t-2 border-rule-2" : ""}`}>
            {group.map((m) => {
              const on = isCurrent(m, pathname);
              return (
                <li key={m.href}>
                  <a href={m.href} aria-current={on ? "page" : undefined} className={`${item} ${on ? "text-gold" : "text-ink"}`}>
                    {m.label}{on && <span className="font-mono text-[10px] tracking-[0.18em]">Here</span>}
                  </a>
                </li>
              );
            })}
            {gi === menuFor(signedIn).length - 1 && (
              <li>
                {signedIn ? (
                  <form action="/api/auth/logout" method="post"><button type="submit" className="flex min-h-[48px] w-full items-center px-5 font-mono text-[11px] uppercase tracking-[0.18em] text-muted">Sign out</button></form>
                ) : (
                  <a href={signInHref(here)} className="flex min-h-[48px] items-center px-5 font-mono text-[11px] uppercase tracking-[0.18em] text-gold">Sign in</a>
                )}
              </li>
            )}
          </ul>
        ))}
      </nav>
    </details>
  );
}
