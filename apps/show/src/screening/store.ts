import { createHash } from "node:crypto";
import { inArray, sql } from "drizzle-orm";
import { showTextScreening, type Database } from "@factions/db";

export type Verdict = { verdict: "allow" | "block"; source: "blocklist" | "llm" | "operator"; reason: string | null };

export interface ScreeningStore {
  get(texts: string[]): Promise<Map<string, Verdict>>;
  /** ⚠️ Must never let an automatic verdict overwrite an `operator` one. */
  put(text: string, v: Verdict): Promise<void>;
}

export const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

/** For `--dry-run` and tests. Nothing survives the process. */
export class MemoryScreeningStore implements ScreeningStore {
  private readonly m = new Map<string, Verdict>();
  async get(texts: string[]) {
    return new Map(texts.flatMap((t) => (this.m.has(t) ? [[t, this.m.get(t)!] as const] : [])));
  }
  async put(text: string, v: Verdict) {
    if (this.m.get(text)?.source === "operator" && v.source !== "operator") return;
    this.m.set(text, v);
  }
}

export class PgScreeningStore implements ScreeningStore {
  constructor(private readonly db: Database) {}

  async get(texts: string[]) {
    if (texts.length === 0) return new Map<string, Verdict>();
    const rs = await this.db.select().from(showTextScreening).where(inArray(showTextScreening.textSha256, texts.map(sha256)));
    return new Map(rs.map((r) => [r.text, { verdict: r.verdict, source: r.source, reason: r.reason }] as const));
  }

  async put(text: string, v: Verdict) {
    const decidedAt = new Date();
    await this.db.insert(showTextScreening)
      .values({ textSha256: sha256(text), text, verdict: v.verdict, source: v.source, reason: v.reason, decidedAt })
      .onConflictDoUpdate({
        target: showTextScreening.textSha256,
        set: { verdict: v.verdict, source: v.source, reason: v.reason, decidedAt },
        // ⚠️ The operator's word is final: an automatic pass may not overwrite it.
        setWhere: sql`${showTextScreening.source} <> 'operator' or ${v.source}::text = 'operator'`,
      });
  }
}
