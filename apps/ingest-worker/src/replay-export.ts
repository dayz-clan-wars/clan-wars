const EXPORT_RE = /^\[(\w+)\]\s+(\S+Z)\s+(\S+\.ADM):(\d+)\s+\|\s+(.*)$/u;
const FILENAME_TIME_RE = /_(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})-(\d{2})\.ADM$/u;

export type ExportLine = {
  map: string;
  occurredAt: Date;
  filename: string;
  lineIndex: number;
  content: string;
};

export function parseExportLine(raw: string): ExportLine | null {
  const m = EXPORT_RE.exec(raw);
  if (!m) return null;
  return {
    map: m[1]!.toLowerCase(),
    occurredAt: new Date(m[2]!),
    filename: m[3]!,
    lineIndex: parseInt(m[4]!, 10),
    content: m[5]!,
  };
}

/** The ADM filename encodes the server's boot instant, which the export header does not repeat. */
function bootFromFilename(filename: string): Date | null {
  const m = FILENAME_TIME_RE.exec(filename);
  if (!m) return null;
  return new Date(Date.UTC(
    parseInt(m[1]!, 10), parseInt(m[2]!, 10) - 1, parseInt(m[3]!, 10),
    parseInt(m[4]!, 10), parseInt(m[5]!, 10), parseInt(m[6]!, 10),
  ));
}

export type ExportGroups = {
  groups: Map<string, { map: string; bootAt: Date; lines: string[] }>;
  /**
   * Lines that failed parseExportLine — e.g. the export's comment header, or
   * ADM boot-header lines whose timestamp column is empty. Harmless (they
   * carry no events, and bootAt is derived from the filename, not these
   * lines), but a silent count is how a real regression hides. Reported by
   * replay-main.ts so a change in this number is visible.
   */
  skipped: number;
};

export function groupExportByFile(lines: string[]): ExportGroups {
  const groups = new Map<string, { map: string; bootAt: Date; lines: string[] }>();
  let skipped = 0;

  for (const raw of lines) {
    const parsed = parseExportLine(raw);
    if (!parsed) {
      skipped++;
      continue;
    }

    const bootAt = bootFromFilename(parsed.filename);
    if (!bootAt) {
      // Silently dropping here would erase every line of this file from the
      // database with no error, no log line, and no way to notice short of
      // manually re-measuring counts against the raw export. Fail loudly.
      throw new Error(
        `groupExportByFile: cannot derive boot time from filename "${parsed.filename}" ` +
        `(does not match ${FILENAME_TIME_RE})`,
      );
    }

    let group = groups.get(parsed.filename);
    if (!group) {
      group = { map: parsed.map, bootAt, lines: [] };
      groups.set(parsed.filename, group);
    }
    group.lines.push(parsed.content);
  }

  return { groups, skipped };
}
