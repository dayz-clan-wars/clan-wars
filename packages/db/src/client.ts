import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

export type Database = ReturnType<typeof createClient>;

export type ClientOptions = {
  /**
   * Every connection starts with `default_transaction_read_only = on`, so any write
   * fails in Postgres itself. For tools pointed at `factions_live` that promise to
   * write nothing (the weekly show's `--dry-run`).
   *
   * ⚠️ A startup parameter, not a `SET`: a `SET` would land on one pooled connection
   * and the other nine would stay writable.
   */
  readOnly?: boolean;
};

export function createClient(url: string, opts: ClientOptions = {}) {
  const sql = postgres(url, {
    max: 10,
    // postgres.js TypeScript types expect a boolean for default_transaction_read_only,
    // but Postgres startup parameters accept "on"/"off" strings at runtime. The string
    // form is required here — postgres.js passes it to the server as a startup parameter,
    // not a SET, so it must be the exact string Postgres recognizes.
    ...(opts.readOnly
      ? {
          connection: {
            default_transaction_read_only: "on" as unknown as boolean,
          },
        }
      : {}),
  });
  return drizzle(sql, { schema });
}
