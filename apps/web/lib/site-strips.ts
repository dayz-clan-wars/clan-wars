/**
 * The strips under the site's top bar: the server name, the raid and restart
 * timers, and the install offer. They are wrapped in one element so a page
 * that is `fixed` below the bar (the map) can measure all of them at once.
 */
export const SITE_STRIPS_ID = "site-strips";

/** The map's top edge: under the sticky top bar and the strips below it. */
export function mapTop(stripsPx: number): string {
  return `calc(var(--spacing-bar) + ${Math.max(0, Math.round(stripsPx))}px)`;
}
