import type { Database } from "@factions/db";
import { admFiles, rawLines } from "@factions/db";
import { appendEvent } from "@factions/event-log";
import { poleKey } from "@factions/domain";
import { parseLine, eventTypeFor, TimelineCursor } from "@factions/adm-parser";
import { and, eq } from "drizzle-orm";

export type IngestOptions = {
  serverId: number;
  filename: string;
  /** Nitrado download path, when the bytes came from Nitrado. */
  path?: string | null;
  bootAt: Date;
  lines: string[];
  clockOffsetMs: number;
  /**
   * Whether this file is finished. FALSE for the newest file, which the
   * server is still writing — marking it complete would make the next tick
   * skip the lines it is about to gain.
   */
  markComplete: boolean;
};

export type IngestResult = {
  linesCaptured: number;
  eventsAppended: number;
  /** The new resume cursor: how many lines of this file have been ingested. */
  linesIngested: number;
  /**
   * Raw lines that mention `TerritoryFlag` or `Flag Pole` but produced no event.
   *
   * ⚠️ This is the canary for parser false negatives. ADM logs contain zero
   * base-destruction events, so the flag-lower is the ONLY raid signal this
   * product will ever have — and `parseLine` returns `[]` (and
   * `parseFlagChange` returns `null`) for anything it cannot interpret. A
   * regression that stops matching lowers yields zero events, zero errors and
   * a green backfill. A non-zero value here means the parser saw flag-shaped
   * text it could not interpret; investigate before trusting any count.
   */
  unparsedFlagLines: number;
};

/** Text that makes a raw line "flag-shaped" for the false-negative canary. */
const FLAG_SHAPED_RE = /TerritoryFlag|Flag Pole/u;

export async function ingestFile(db: Database, opts: IngestOptions): Promise<IngestResult> {
  const [file] = await db.insert(admFiles)
    .values({ serverId: opts.serverId, filename: opts.filename, path: opts.path ?? null, bootAt: opts.bootAt })
    .onConflictDoNothing({ target: [admFiles.serverId, admFiles.filename] })
    .returning();

  const existing = file ?? (await db.select().from(admFiles).where(
    and(eq(admFiles.serverId, opts.serverId), eq(admFiles.filename, opts.filename)),
  ))[0]!;
  const admFileId = existing.id;

  const total = opts.lines.length;
  // Clamp: the file shrank or rotated. Never reprocess under this row's id.
  const from = Math.min(Math.max(existing.linesIngested, 0), total);

  const cursor = new TimelineCursor(opts.bootAt, opts.clockOffsetMs);
  let eventsAppended = 0;
  let linesCaptured = 0;
  let unparsedFlagLines = 0;

  for (let lineIndex = 0; lineIndex < total; lineIndex++) {
    const raw = opts.lines[lineIndex]!;

    // ⚠️ The cursor advances over EVERY line, including ones already written.
    // It is stateful — it rolls the date forward on a backwards clock jump —
    // so starting it at `from` would lose every midnight crossed before the
    // resume point and put every later timestamp a day early, silently.
    const occurredAt = cursor.advance(raw);

    // Writes, and only writes, resume at the cursor.
    if (lineIndex < from) continue;

    const [stored] = await db.insert(rawLines)
      .values({ admFileId, lineIndex, content: raw })
      .onConflictDoNothing({ target: [rawLines.admFileId, rawLines.lineIndex] })
      .returning();
    if (stored) linesCaptured++;

    if (!occurredAt) {
      if (FLAG_SHAPED_RE.test(raw)) unparsedFlagLines++;
      continue;
    }

    const parsed = parseLine(raw);
    if (parsed.length === 0 && FLAG_SHAPED_RE.test(raw)) unparsedFlagLines++;

    for (let subIndex = 0; subIndex < parsed.length; subIndex++) {
      const line = parsed[subIndex]!;
      const type = eventTypeFor(line);
      if (!type) continue;

      const inserted = await appendEvent(db, {
        serverId: opts.serverId,
        admFileId,
        lineIndex,
        subIndex,
        type,
        occurredAt,
        payload: toPayload(line),
        rawLineId: stored?.id,
      });
      if (inserted) eventsAppended++;
    }
  }

  await db.update(admFiles)
    .set({ linesIngested: total, complete: opts.markComplete, path: opts.path ?? existing.path })
    .where(eq(admFiles.id, admFileId));

  return { linesCaptured, eventsAppended, unparsedFlagLines, linesIngested: total };
}

/** Flatten a ParsedLine into the jsonb payload shape the projector reads. */
function toPayload(line: ReturnType<typeof parseLine>[number]): unknown {
  switch (line.kind) {
    case "flag":
      return {
        gamertag: line.change.gamertag,
        dayzId: line.change.dayzId,
        texture: line.change.texture,
        action: line.change.action,
        pole: line.change.pole,
        poleKey: poleKey(line.change.pole),
        player: line.change.player,
      };
    case "flagpole":
      return {
        gamertag: line.event.gamertag,
        dayzId: line.event.dayzId,
        action: line.event.action,
        part: line.event.part,
        tool: line.event.tool,
        player: line.event.player,
      };
    case "position":
      return { gamertag: line.gamertag, dayzId: line.dayzId, pos: line.pos };
    case "emote":
      return {
        gamertag: line.event.gamertag,
        dayzId: line.event.dayzId,
        emote: line.event.emote,
        item: line.event.item,
      };
    case "roster":
      return { count: line.count };
  }
}
