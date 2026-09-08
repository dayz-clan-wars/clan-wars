import { MenuList } from "./menu-list";

/**
 * The 52px top bar (`--spacing-bar` in globals.css): the mark and wordmark on
 * the left, the Menu on the right. The drawer is a <details>, the same
 * no-JavaScript mechanism the guide's phone top bar uses; menu-list.tsx adds
 * Escape and click-outside on top.
 *
 * ⚠️ z-[1300]: Leaflet's panes sit at 200–700 and its controls at 1000, and
 * the map page's own sheets at 1100–1200. The bar and its open drawer must
 * paint over all of them or the menu is unreachable from the one page a
 * player spends the most time on.
 */
export function SiteBar({ signedIn }: { signedIn: boolean }) {
  return (
    <header className="sticky top-0 z-[1300] flex h-bar items-center justify-between border-b border-rule bg-frame px-4">
      <a className="flex items-center gap-2.5 font-display text-sm tracking-[0.02em] text-ink" href={signedIn ? "/me" : "/"}>
        <img src="/mark.png" alt="" width={28} height={28} />
        Clan Wars
      </a>
      <details className="group relative">
        <summary className="flex min-h-[44px] cursor-pointer list-none items-center px-1 font-mono text-xs uppercase tracking-[0.18em] text-gold group-open:text-ink [&::-webkit-details-marker]:hidden">
          Menu
        </summary>
        <div className="absolute right-0 top-full mt-1 max-h-[80dvh] w-[min(86vw,320px)] overflow-y-auto rounded-md border border-rule-2 bg-surface p-2 shadow-[0_12px_32px_rgba(0,0,0,.5)]">
          <MenuList signedIn={signedIn} />
        </div>
      </details>
    </header>
  );
}
