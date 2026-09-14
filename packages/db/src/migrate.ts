import { migrate } from "drizzle-orm/postgres-js/migrator";
import { MIGRATIONS_FOLDER } from "./migrations-folder";
import type { Database } from "./client";

export async function runMigrations(db: Database): Promise<void> {
  await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
}
