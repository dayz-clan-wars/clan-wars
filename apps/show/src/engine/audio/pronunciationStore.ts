/** One frozen pronunciation decision for a piece of spoken text (a gamertag, today). */
export type PronunciationRow = { text: string; spoken: string; source: "override" | "llm" | "fallback" };

/**
 * `show_pronunciations` rows are frozen once written (spec §4.2): `insertMissing` never
 * overwrites an existing row, unlike KOTH's upsert.
 */
export interface PronunciationStore {
  get(texts: string[]): Promise<Record<string, string>>;
  insertMissing(rows: PronunciationRow[]): Promise<void>;
}

/** For `--dry-run` and tests. Nothing survives the process. */
export class MemoryPronunciationStore implements PronunciationStore {
  private readonly m = new Map<string, string>();

  async get(texts: string[]): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    for (const t of texts) if (this.m.has(t)) out[t] = this.m.get(t)!;
    return out;
  }

  async insertMissing(rows: PronunciationRow[]): Promise<void> {
    for (const r of rows) if (!this.m.has(r.text)) this.m.set(r.text, r.spoken);
  }
}
