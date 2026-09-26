import { inArray } from "drizzle-orm";
import { showPronunciations, type Database } from "@factions/db";
import type { PronunciationRow, PronunciationStore } from "../engine/audio/pronunciationStore.js";

/**
 * The Postgres-backed pronunciation store, over `show_pronunciations`. Rows are frozen once
 * written (spec §4.2): `insertMissing` inserts with `on conflict (text) do nothing`, never
 * updates — a named change from the KOTH cache, which upserted.
 */
export class PgPronunciationStore implements PronunciationStore {
  constructor(private readonly db: Database) {}

  async get(texts: string[]): Promise<Record<string, string>> {
    if (texts.length === 0) return {};
    const rows = await this.db.select().from(showPronunciations).where(inArray(showPronunciations.text, texts));
    const out: Record<string, string> = {};
    for (const r of rows) out[r.text] = r.spoken;
    return out;
  }

  async insertMissing(rows: PronunciationRow[]): Promise<void> {
    if (rows.length === 0) return;
    await this.db.insert(showPronunciations)
      .values(rows.map((r) => ({ text: r.text, spoken: r.spoken, source: r.source })))
      .onConflictDoNothing({ target: showPronunciations.text });
  }
}

/**
 * For `--render` against a database that has the show's tables: reads the real rows and
 * writes only to a separate store (a `MemoryPronunciationStore` for a dry/render run), the
 * same read-through pattern as plan 1's `ReadThroughScreeningStore`. ⚠️ Never writes to
 * `read`, so it is safe on a read-only connection.
 */
export class ReadThroughPronunciationStore implements PronunciationStore {
  constructor(private readonly read: PronunciationStore, private readonly write: PronunciationStore) {}

  async get(texts: string[]): Promise<Record<string, string>> {
    const fromRead = await this.read.get(texts);
    const fromWrite = await this.write.get(texts);
    return { ...fromRead, ...fromWrite };
  }

  async insertMissing(rows: PronunciationRow[]): Promise<void> {
    await this.write.insertMissing(rows);
  }
}
