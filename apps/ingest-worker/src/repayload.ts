import type { Database } from "@factions/db";
import { events, rawLines } from "@factions/db";
import type { EventType } from "@factions/domain";
import { parseLine, eventTypeFor } from "@factions/adm-parser";
import { and, asc, eq, gt, inArray } from "drizzle-orm";
import { toPayload } from "./ingest.js";

export type RepayloadResult = { scanned: number; changed: Record<string, number>; typeMismatch: number; noRawLine: number };

const BATCH = 1000;

/** Key-order-independent JSON equality (jsonb does not preserve key order). */
function same(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a as object).filter((k) => (a as Record<string, unknown>)[k] !== undefined);
  const kb = Object.keys(b as object).filter((k) => (b as Record<string, unknown>)[k] !== undefined);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => same((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}

/**
 * Re-derive stored event payloads from their raw lines with the CURRENT parser,
 * in place. Production rows were written by an older parser (short hit labels,
 * wrong death causes, ruin repairs with the tool glued onto `structure`).
 *
 * ⚠️ Never inserts or deletes: event ids are referenced by feed cursors, zone
 * violations, kills and positions. Only `payload` is ever written.
 * ⚠️ Joins on (adm_file_id, line_index), not raw_line_id — ~1,700 old rows have it null.
 * ⚠️ A row whose re-parse is missing or has a different type is counted and left alone.
 */
export async function repayloadEvents(
  db: Database,
  opts: { types: EventType[]; apply: boolean; log?: (s: string) => void },
): Promise<RepayloadResult> {
  const res: RepayloadResult = { scanned: 0, changed: {}, typeMismatch: 0, noRawLine: 0 };
  if (opts.types.length === 0) return res;
  let after = 0;
  for (;;) {
    const batch = await db
      .select({ id: events.id, type: events.type, subIndex: events.subIndex, payload: events.payload, content: rawLines.content })
      .from(events)
      .leftJoin(rawLines, and(eq(rawLines.admFileId, events.admFileId), eq(rawLines.lineIndex, events.lineIndex)))
      .where(and(gt(events.id, after), inArray(events.type, opts.types)))
      .orderBy(asc(events.id))
      .limit(BATCH);
    if (batch.length === 0) break;
    after = batch[batch.length - 1]!.id;
    for (const row of batch) {
      res.scanned++;
      if (row.content === null) { res.noRawLine++; continue; }
      const line = parseLine(row.content)[row.subIndex];
      if (!line || eventTypeFor(line) !== row.type) { res.typeMismatch++; continue; }
      const next = toPayload(line);
      if (same(next, row.payload)) continue;
      res.changed[row.type] = (res.changed[row.type] ?? 0) + 1;
      if (opts.apply) await db.update(events).set({ payload: next }).where(eq(events.id, row.id));
    }
    opts.log?.(`scanned ${res.scanned} (through event ${after})`);
  }
  return res;
}
