import { parseBootHeader } from "@factions/adm-parser";

export type ParseAdmOptions = {
  /**
   * Drop the final line when the text does not end in a newline.
   *
   * ⚠️ Pass true ONLY for the file the server is still appending to. That
   * download can end mid-line, and `split` yields the half-written fragment as
   * a full element: it is non-blank, so it is stored at index `N-1` and the
   * cursor advances to `N`. The next tick sees the COMPLETE line at `N-1`,
   * skips it (writes resume at the cursor) and `onConflictDoNothing` would
   * discard it anyway — the line is permanently truncated and any event it
   * carried is permanently lost. Defaults to FALSE: for a finished file the
   * last line is real, and dropping it would lose a line for good.
   */
  dropPartialTrailingLine?: boolean;
};

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
export function parseAdmContent(
  text: string,
  opts: ParseAdmOptions = {},
): { bootAt: Date; lines: string[] } {
  const parts = text.split(/\r?\n/);
  let lines = parts.filter((l) => l.trim().length > 0);
  // Only the LAST element of the raw split can be a half-written line, and
  // only when it carries content: text ending in "...L5\n   " has a blank
  // final element, so L5 itself arrived whole and must not be dropped.
  const tailIsPartial = (parts[parts.length - 1] ?? "").trim().length > 0;
  if (opts.dropPartialTrailingLine && tailIsPartial && lines.length > 0) {
    lines = lines.slice(0, -1);
  }
  for (const line of lines) {
    const boot = parseBootHeader(line);
    if (boot) return { bootAt: boot, lines };
  }
  throw new Error('No "AdminLog started on" header found');
}
