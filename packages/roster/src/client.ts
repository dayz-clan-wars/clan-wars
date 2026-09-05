import { createClient, type Database } from "@factions/db";

let cached: Database | null = null;

/**
 * The ONE database client the site has. It lives here so that `apps/web`
 * never names DATABASE_URL or imports @factions/db — smoke.test.ts holds both
 * lines — and so the connection pool is shared across every request in the
 * standalone server rather than opened per page.
 *
 * ⚠️ Throws when DATABASE_URL is unset rather than falling back. A web
 * container without the variable must fail its first page load loudly, not
 * render empty states that read as "you have no clan".
 */
export function db(): Database {
  if (cached) return cached;
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error("DATABASE_URL is not set. @factions/roster cannot read anything without it.");
  }
  cached = createClient(url);
  return cached;
}
