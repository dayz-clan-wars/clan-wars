"use client";
import { useRef } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import { isCurrent, menuFor, signInHref, type Counts } from "@/lib/menu";
import { POPOVER_GROUP } from "@/lib/popover";
import { GuideSearch } from "@/app/guide/search";
import type { SearchEntry } from "@/app/guide/index";

function useHere() {
  const pathname = usePathname();
  const search = useSearchParams().toString();
  return { pathname, here: search ? `${pathname}?${search}` : pathname };
}

/** The gold count on an item: things waiting there. Hidden at zero. */
function Badge({ n, label }: { n: number; label: string }) {
  if (n <= 0) return null;
  return <span className="inline-flex h-[18px] min-w-[18px] items-center justify-center bg-gold px-1.5 font-mono text-[11px] font-bold text-ground"><span className="sr-only">{label}: </span>{n}</span>;
}
const countFor = (badge: "you" | "clan" | undefined, counts: Counts) => (badge ? counts[badge] : 0);

/**
 * The bar's gold Sign in, beside Menu for a signed-out visitor: the one action
 * worth keeping out of the drawer. Client-side to carry the current path.
 * ⚠️ From sm up only: at 375px beside the guide's Contents and Menu it wrapped
 * itself and the wordmark onto two lines. Phones have it at the foot of the drawer.
 */
export function SignInButton() {
  const { here } = useHere();
  return <a href={signInHref(here)} className="hidden min-h-[44px] items-center whitespace-nowrap bg-gold px-4 sm:flex font-display text-xs uppercase tracking-[0.06em] text-ground hover:bg-gold-hover">Sign in</a>;
}

/**
 * The Menu drawer, at every width: a <details> so it works without JavaScript and closes on
 * navigation, with a dimmed backdrop. The summary reads "Menu" closed and
 * "Close" open, filled gold when open. Escape, click-outside and
 * one-popover-at-a-time come from PopoverDismiss (mounted by SiteBar) for the
 * whole popover group, so the drawer no longer carries listeners of its own.
 */
export function Drawer({ signedIn, guideIndex, counts = { you: 0, clan: 0 } }: { signedIn: boolean; guideIndex?: SearchEntry[]; counts?: Counts }) {
  const { pathname, here } = useHere();
  const root = useRef<HTMLDetailsElement>(null);

  const item = "flex min-h-[48px] items-center justify-between px-5 font-display text-sm uppercase tracking-[0.06em]";
  return (
    <details ref={root} name={POPOVER_GROUP} className="group">
      <summary className="relative flex min-h-[44px] cursor-pointer list-none items-center border border-gold px-3 font-display text-xs uppercase tracking-[0.06em] text-gold group-open:bg-gold group-open:text-ground [&::-webkit-details-marker]:hidden">
        <span className="group-open:hidden">Menu</span><span className="hidden group-open:inline">Close</span>
        {counts.you + counts.clan > 0 && <span className="absolute -right-2 -top-2 group-open:hidden"><Badge n={counts.you + counts.clan} label="waiting" /></span>}
      </summary>
      {/* The backdrop sits under the panel but over the page; a tap on it is a click outside the panel's <details>… except it IS inside. So it closes itself. */}
      <div className="fixed inset-x-0 bottom-0 top-bar z-[1290] bg-ground/70" onClick={() => root.current?.removeAttribute("open")} aria-hidden="true" />
      <nav aria-label="Site" className="absolute right-3 top-[calc(var(--spacing-bar)+8px)] z-[1300] max-h-[calc(100dvh-var(--spacing-bar)-20px)] w-[300px] max-w-[calc(100vw-24px)] overflow-y-auto border-2 border-rule-2 bg-frame shadow-[0_16px_40px_rgba(0,0,0,.6)]">
        {guideIndex && <div className="border-b-2 border-rule-2 p-3"><GuideSearch index={guideIndex} compact /></div>}
        {menuFor(signedIn).map((group, gi) => (
          <ul key={gi} className={`py-2 ${gi > 0 ? "border-t-2 border-rule-2" : ""}`}>
            {group.map((m) => {
              const on = isCurrent(m, pathname);
              return (
                <li key={m.href}>
                  <a href={m.href} aria-current={on ? "page" : undefined} className={`${item} ${on ? "text-gold" : "text-ink"}`}>
                    <span className="flex items-center gap-2.5">{m.label}<Badge n={countFor(m.badge, counts)} label="waiting" /></span>{on && <span className="font-mono text-[11px] tracking-[0.18em]">Here</span>}
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
