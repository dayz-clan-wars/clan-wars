/**
 * The site's own base URL, for a link a notice DM hands the player (e.g.
 * `invited`'s `${siteBaseUrl()}/me`). Internal, not a public export: the site
 * itself has no reason to ask its own address, and the bot never calls
 * `createInvite` any more, so nothing outside `inviteDb` needs this.
 *
 * Reads the same `SITE_BASE_URL` variable the bot's own notices/links use —
 * one address for the whole deployment, not a second copy that could drift.
 *
 * ⚠️ Trailing slash(es) stripped, mirroring `apps/bot/src/config.ts`'s own
 * handling of this exact variable. Without it, an operator setting
 * `SITE_BASE_URL` with a trailing slash (a form the bot's own config
 * anticipates and tests) turns `invited`'s link into `.../me` with a double
 * slash.
 */
export function siteBaseUrl(): string {
  return (process.env.SITE_BASE_URL ?? "https://dayzclanwars.com").replace(/\/+$/u, "");
}
