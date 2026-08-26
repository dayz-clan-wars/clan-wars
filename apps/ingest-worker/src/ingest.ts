import type { Database } from "@factions/db";
import { admFiles, rawLines } from "@factions/db";
import { appendEvent } from "@factions/event-log";
import { poleKey } from "@factions/domain";
import { parseLine, eventTypeFor, TimelineCursor } from "@factions/adm-parser";
import { and, eq } from "drizzle-orm";

export type IngestOptions = {
  serverId: number;
  map: string;
  filename: string;
  bootAt: Date;
  lines: string[];
  clockOffsetMs: number;
};

export type IngestResult = { linesCaptured: number; eventsAppended: number };

export async function ingestFile(db: Database, opts: IngestOptions): Promise<IngestResult> {
  const [file] = await db.insert(admFiles)
    .values({ serverId: opts.serverId, filename: opts.filename, bootAt: opts.bootAt })
    .onConflictDoNothing({ target: [admFiles.serverId, admFiles.filename] })
    .returning();

  const admFileId = file?.id ?? (await db.select().from(admFiles).where(
    and(eq(admFiles.serverId, opts.serverId), eq(admFiles.filename, opts.filename)),
  ))[0]!.id;

  const cursor = new TimelineCursor(opts.bootAt, opts.clockOffsetMs);
  let eventsAppended = 0;
  let linesCaptured = 0;

  for (let lineIndex = 0; lineIndex < opts.lines.length; lineIndex++) {
    const raw = opts.lines[lineIndex]!;

    const [stored] = await db.insert(rawLines)
      .values({ admFileId, lineIndex, content: raw })
      .onConflictDoNothing({ target: [rawLines.admFileId, rawLines.lineIndex] })
      .returning();
    if (stored) linesCaptured++;

    const occurredAt = cursor.advance(raw);
    if (!occurredAt) continue;

    const parsed = parseLine(raw);
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
    .set({ linesIngested: opts.lines.length, complete: true })
    .where(eq(admFiles.id, admFileId));

  return { linesCaptured, eventsAppended };
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
    case "roster":
      return { count: line.count };
  }
}
