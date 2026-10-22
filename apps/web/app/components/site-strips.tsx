"use client";
import { usePathname } from "next/navigation";
import { SITE_STRIPS_ID, stripsHidden } from "@/lib/site-strips";

/**
 * The one wrapper around the strips under the top bar, so the map (fixed
 * below the bar) can measure every strip at once — lib/site-strips.ts.
 *
 * ⚠️ `hidden`, not unmounted. The strips are server components rendered by
 * the layout, which cannot see the path; hiding keeps the install strip's
 * state across a client navigation, still gives the map an `offsetHeight` of
 * 0 to measure, and takes a hidden strip's buttons out of the tab order.
 */
export function SiteStrips({ children }: { children: React.ReactNode }) {
  return <div id={SITE_STRIPS_ID} hidden={stripsHidden(usePathname())}>{children}</div>;
}
