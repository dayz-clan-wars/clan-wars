import type { SearchEntry } from "@/app/guide/index";
import type { NoticeRow } from "@factions/roster";
import { BarNav, Drawer } from "./menu-list";
import { NotificationsBell } from "@/app/components/notifications-bell";
import { PopoverDismiss } from "@/app/components/popover-dismiss";
import type { Counts } from "@/lib/menu";

/**
 * The 52px top bar (`--spacing-bar` in globals.css), from the design canvas:
 * the mark and wordmark on the left; on desktop the nav inline on the right,
 * each item a cell with a hairline on its left and the current one gold with
 * a 2px gold rule under it; on phones a bordered gold "Menu" that opens the
 * drawer (menu-list.tsx) over a dimmed page.
 *
 * `crumb` is the guide's "/ Field guide"; `extra` is a slot beside the phone
 * Menu button (the guide's Contents).
 *
 * ⚠️ z-[1300]: Leaflet's panes sit at 200–700 and its controls at 1000, and
 * the map page's own sheets at 1100–1200. The bar and its open drawer must
 * paint over all of them or the menu is unreachable from the one page a
 * player spends the most time on.
 */
/** `guideIndex`: the guide search box at the top of the phone drawer. Omit it and the drawer has no search (the guide layout carries its own). */
export function SiteBar({ signedIn, crumb, extra, guideIndex, counts, notifications }: {
  signedIn: boolean; crumb?: string; extra?: React.ReactNode; guideIndex?: SearchEntry[]; counts?: Counts;
  /** The bell. Omitted for a signed-out visitor, who has no notices. */
  notifications?: { unread: number; recent: NoticeRow[]; now?: Date };
}) {
  return (
    <header className="sticky top-0 z-[1300] flex h-bar items-center justify-between border-b-2 border-rule-2 bg-frame px-4 lg:px-5 xl:px-8">
      {/* ⚠️ Between lg and xl the wordmark and the crumb give up their width so every nav cell fits, the Guide included (M2). The mark stays; the name stays for a screen reader. */}
      <a className="flex items-center gap-2.5 font-display text-sm uppercase tracking-[0.02em] text-ink" href="/">
        <img src="/mark.png" alt="" width={28} height={28} />
        <span className="lg:max-xl:sr-only">Clan Wars</span>
        {crumb && <span className="ml-1.5 hidden text-muted xl:inline">/ {crumb}</span>}
      </a>
      <div className="hidden h-full items-stretch lg:flex">
        <BarNav signedIn={signedIn} counts={counts} />
        {signedIn && notifications && <NotificationsBell {...notifications} />}
      </div>
      <div className="flex items-center gap-2 lg:hidden">
        {extra}
        {signedIn && notifications && <NotificationsBell {...notifications} />}
        <Drawer signedIn={signedIn} guideIndex={guideIndex} counts={counts} />
      </div>
      {/* One handler for the whole popover group (lib/popover.ts): Escape, click-outside, one open at a time. */}
      <PopoverDismiss />
    </header>
  );
}
