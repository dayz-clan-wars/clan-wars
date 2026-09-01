import { parseBootHeader } from "@factions/adm-parser";

/**
 * Split one ADM file's text into its boot instant and its non-blank lines.
 *
 * ⚠️ Blank lines are dropped, so `lines[i]` is the i-th NON-BLANK line. That
 * ordinal is what `raw_lines.line_index` and `adm_files.lines_ingested` have
 * meant since Plan 1; do not switch to raw file offsets.
 *
 * The boot header names the file's start instant. Without it no line can be
 * given an absolute timestamp, so the file is rejected rather than partially
 * ingested.
 */
export function parseAdmContent(text: string): { bootAt: Date; lines: string[] } {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  for (const line of lines) {
    const boot = parseBootHeader(line);
    if (boot) return { bootAt: boot, lines };
  }
  throw new Error('No "AdminLog started on" header found');
}
