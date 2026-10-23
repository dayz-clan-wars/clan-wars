import type { SearchEntry } from "@/app/guide/index";
import type { NoticeRow } from "@factions/roster";
import { Drawer, SignInButton } from "./menu-list";
import { NotificationsBell } from "@/app/components/notifications-bell";
import { PopoverDismiss } from "@/app/components/popover-dismiss";
import type { Counts } from "@/lib/menu";

/**
 * The 52px top bar (`--spacing-bar` in globals.css): the mark and wordmark on
 * the left; on the right the bell, a gold Sign in for a signed-out visitor (sm and up),
 * and a bordered gold "Menu" that opens the drawer (menu-list.tsx) over a
 * dimmed page, at every width. Desktop had the nav inline until it ran out of
 * room at 1024px; the drawer holds every page and never does.
 *
 * `crumb` is the guide's "/ Field guide"; `extra` is a slot beside the Menu
 * button on phones (the guide's Contents; desktop has the guide's sidebar).
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
      <a className="flex items-center gap-2.5 font-display text-sm uppercase tracking-[0.02em] text-ink" href="/">
        <img src="/mark.png" alt="" width={28} height={28} />
        <span className="whitespace-nowrap">Clan Wars</span>
        {crumb && <span className="ml-1.5 hidden text-muted lg:inline">/ {crumb}</span>}
      </a>
      <div className="flex items-center gap-2">
        {extra && <div className="lg:hidden">{extra}</div>}
        {signedIn && notifications && <NotificationsBell {...notifications} />}
        {!signedIn && <SignInButton />}
        <Drawer signedIn={signedIn} guideIndex={guideIndex} counts={counts} />
      </div>
      {/* One handler for the whole popover group (lib/popover.ts): Escape, click-outside, one open at a time. */}
      <PopoverDismiss />
    </header>
  );
}
