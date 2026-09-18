import { compareSemver } from "./tags";

/**
 * `## [1.17.0] - 2026-09-17`. Anchored at both ends, which is load-bearing:
 * `[Unreleased]` has no date and does not match, and neither does
 * `## [1.16.2] - 2026-09-17 [WITHDRAWN]` — a tag this repo records as "not a
 * release, never deploy this tag". ⚠️ The trailing `$` is therefore the only
 * thing keeping a rehearsal build out of a player-facing channel. A future
 * "tidy-up" that loosens this regex announces both withdrawn tags.
 */
const HEADING = /^## \[(\d+\.\d+\.\d+)\]\s*-\s*(\d{4}-\d{2}-\d{2})\s*$/u;

export interface ChangelogRelease {
  /** Without the leading `v` — "1.17.0", as the heading writes it. */
  version: string;
  /** As written in the heading: "2026-09-17". */
  date: string;
  /** Everything under the heading, trimmed. Markdown, verbatim. */
  body: string;
}

/**
 * The releases in a Keep a Changelog file, oldest first.
 *
 * ⚠️ Ascending, though the file is newest-first: `release:sync` inserts in this
 * order and the bot posts by insert id, so this sort is what puts v1.0.0 above
 * v1.10.0 in the channel. A lexical sort would put v1.10.0 first.
 *
 * ⚠️ A version with no `- YYYY-MM-DD` on its heading does not match and is
 * therefore never announced. That is deliberate: the date becomes `released_at`,
 * and an announcement is not worth inventing a date for.
 */
export function parseChangelog(text: string): ChangelogRelease[] {
  const out: ChangelogRelease[] = [];
  let open: { version: string; date: string; body: string[] } | null = null;

  const close = (): void => {
    if (open === null) return;
    out.push({ version: open.version, date: open.date, body: open.body.join("\n").trim() });
    open = null;
  };

  for (const line of text.split("\n")) {
    const m = HEADING.exec(line);
    if (m !== null) {
      close();
      open = { version: m[1]!, date: m[2]!, body: [] };
      continue;
    }
    // ⚠️ Any other `## ` heading ends the open section — `## [Unreleased]`, and
    // whatever a future format adds. `### ` subsections do not, and must not:
    // they are the body.
    if (line.startsWith("## ")) {
      close();
      continue;
    }
    if (open !== null) open.body.push(line);
  }
  close();

  // compareSemver takes `v`-prefixed tags; anything without the prefix sorts as
  // older than everything, which would silently scramble this order.
  return out.sort((a, b) => compareSemver(`v${a.version}`, `v${b.version}`));
}
