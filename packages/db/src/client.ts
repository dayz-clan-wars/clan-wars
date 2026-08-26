import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema.js";

export type Database = ReturnType<typeof createClient>;

export function createClient(url: string) {
  const sql = postgres(url, { max: 10 });
  return drizzle(sql, { schema });
}
