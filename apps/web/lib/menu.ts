/**
 * The site's navigation, as functions of signed-in state. Rendered by
 * app/(site)/site-bar.tsx (the desktop bar) and menu-list.tsx (the phone
 * drawer); pinned by test/menu.test.ts.
 *
 * Two shapes on purpose, from the design canvas: the desktop bar is short and
 * always visible, so Alphas and Seasons live one step down in the scoreboard's
 * own segmented nav; the drawer is a full list, so they are in it.
 *
 * Sign in / sign out are not items here — sign out is a POST form (the logout
 * route refuses GET), and sign in needs the current path, so the bar renders
 * both itself. Vault, board and settings are deliberately absent: they only
 * mean anything inside a clan, and /clan links to all three.
 */
export type MenuItem = {
  label: string;
  href: string;
  /** Paths that light this item up besides its own prefix (Scoreboard owns /alphas and /seasons). */
  also?: readonly string[];
  /** The bar draws this one quieter (the guide is a different kind of place). */
  quiet?: boolean;
};

const MINE: readonly MenuItem[] = [
  { label: "You", href: "/me" },
  { label: "Map", href: "/map" },
  { label: "Your clan", href: "/clan" },
];

const BOARDS: readonly MenuItem[] = [
  { label: "Clans", href: "/clans" },
  { label: "Players", href: "/players" },
  { label: "Scoreboard", href: "/scoreboard", also: ["/alphas", "/seasons"] },
  { label: "War log", href: "/war-log" },
];

const BOARDS_LONG: readonly MenuItem[] = [
  { label: "Clans", href: "/clans" },
  { label: "Players", href: "/players" },
  { label: "Scoreboard", href: "/scoreboard" },
  { label: "Alphas", href: "/alphas" },
  { label: "Seasons", href: "/seasons" },
  { label: "War log", href: "/war-log" },
];

const GUIDE: readonly MenuItem[] = [{ label: "Field guide", href: "/guide" }];
const GUIDE_SHORT: readonly MenuItem[] = [{ label: "Guide", href: "/guide", quiet: true }];

/** The phone drawer, in groups. */
export function menuFor(signedIn: boolean): readonly (readonly MenuItem[])[] {
  return signedIn ? [MINE, BOARDS_LONG, GUIDE] : [BOARDS_LONG, GUIDE];
}

/** The desktop bar, in groups (a gap between them). */
export function barFor(signedIn: boolean): readonly (readonly MenuItem[])[] {
  return signedIn ? [MINE, [...BOARDS, ...GUIDE_SHORT]] : [[...BOARDS, ...GUIDE_SHORT]];
}

/** Whether `pathname` is inside this item. `/clan` must not claim `/clans`. */
export function isCurrent(item: MenuItem, pathname: string): boolean {
  const owns = (p: string) => pathname === p || pathname.startsWith(`${p}/`);
  return owns(item.href) || (item.also ?? []).some(owns);
}

/** /login with the page the visitor was on, so signing in lands them back there. */
export function signInHref(current: string): string {
  return `/login?next=${encodeURIComponent(current)}`;
}
