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
    // ⚠️ A startup parameter, not a `SET`: postgres.js concatenates startup parameters
    // into the startup packet as strings, so boolean `true` is sent as "true", which
    // Postgres accepts. Every pooled connection gets it from initialization, so no
    // connection is accidentally writable.
    ...(opts.readOnly
      ? {
          connection: {
            default_transaction_read_only: true,
          },
        }
      : {}),
  });
  return drizzle(sql, { schema });
}
