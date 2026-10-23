/**
 * The site's navigation, as a function of signed-in state: one list, shown in
 * the Menu drawer (app/(site)/menu-list.tsx) at every width; pinned by
 * test/menu.test.ts. Desktop had its own shorter bar until it ran out of room
 * at 1024px; one list means a new page is added once and the two can never
 * disagree.
 *
 * Sign in / sign out are not items here — sign out is a POST form (the logout
 * route refuses GET), and sign in needs the current path, so the drawer and
 * the bar (a gold Sign in beside Menu) render them themselves. Vault, board and settings are deliberately absent: they only
 * mean anything inside a clan, and /clan links to all three.
 */
export type MenuItem = {
  label: string;
  href: string;
  /** Which of the site's two attention counts sits on this item (App Review §01). */
  badge?: "you" | "clan";
};

/** The counts the bar shows: things waiting on you (/me) and on your clan (/clan). */
export type Counts = { you: number; clan: number };

/** Your places. Notifications is here as well as on the bell, so the list is complete on its own. */
const MINE: readonly MenuItem[] = [
  { label: "You", href: "/me", badge: "you" },
  { label: "Map", href: "/map" },
  { label: "Your clan", href: "/clan", badge: "clan" },
  { label: "Notifications", href: "/notifications" },
];

const BOARDS: readonly MenuItem[] = [
  { label: "Clans", href: "/clans" },
  { label: "Players", href: "/players" },
  { label: "Scoreboard", href: "/scoreboard" },
  { label: "Alphas", href: "/alphas" },
  { label: "Seasons", href: "/seasons" },
  { label: "Live", href: "/live" },
  { label: "War log", href: "/war-log" },
  { label: "Radio", href: "/radio" },
];

const GUIDE: readonly MenuItem[] = [{ label: "Field guide", href: "/guide" }];

/** The Menu drawer, in groups. */
export function menuFor(signedIn: boolean): readonly (readonly MenuItem[])[] {
  return signedIn ? [MINE, BOARDS, GUIDE] : [BOARDS, GUIDE];
}

/** Whether `pathname` is inside this item. `/clan` must not claim `/clans`. */
export function isCurrent(item: MenuItem, pathname: string): boolean {
  return pathname === item.href || pathname.startsWith(`${item.href}/`);
}

/** /login with the page the visitor was on, so signing in lands them back there. */
export function signInHref(current: string): string {
  return `/login?next=${encodeURIComponent(current)}`;
}
