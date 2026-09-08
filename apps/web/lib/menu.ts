/**
 * The site menu's contents, as a function of signed-in state. Rendered by
 * app/(site)/site-bar.tsx; pinned by test/menu.test.ts.
 *
 * Groups render with a rule between them. The first group is the player's own
 * places and exists only when signed in; the middle group is the public
 * boards; the guide stands alone. Sign in / sign out are not items here —
 * sign out is a POST form (the logout route refuses GET), and sign in needs
 * the current path, so the bar renders both itself.
 *
 * Vault, board and settings are deliberately absent: they only mean anything
 * inside a clan, and /clan links to all three.
 */
export type MenuItem = { label: string; href: string };

const MINE: readonly MenuItem[] = [
  { label: "You", href: "/me" },
  { label: "Map", href: "/map" },
  { label: "Your clan", href: "/clan" },
];

const PUBLIC: readonly MenuItem[] = [
  { label: "Clans", href: "/clans" },
  { label: "Players", href: "/players" },
  { label: "Scoreboard", href: "/scoreboard" },
  { label: "Alphas", href: "/alphas" },
  { label: "Seasons", href: "/seasons" },
  { label: "War log", href: "/war-log" },
];

const GUIDE: readonly MenuItem[] = [{ label: "Field guide", href: "/guide" }];

export function menuFor(signedIn: boolean): readonly (readonly MenuItem[])[] {
  return signedIn ? [MINE, PUBLIC, GUIDE] : [PUBLIC, GUIDE];
}

/** /login with the page the visitor was on, so signing in lands them back there. */
export function signInHref(current: string): string {
  return `/login?next=${encodeURIComponent(current)}`;
}
