// Deterministic post-formatting for the two-host AI banter, so the styling is
// guaranteed regardless of exactly how the model wrote it: BORIS/PAVEL always
// bold ALL-CAPS, and every known gamertag wrapped in backticks (code style).

const HOST_RE = /\*{0,2}\b(boris|pavel)\b\*{0,2}/gi;

/** Render every Boris/Pavel mention as bold ALL-CAPS (`**BORIS**` / `**PAVEL**`), idempotently. */
export function boldHostNames(text: string): string {
  return (text ?? "").replace(HOST_RE, (_m, name: string) => `**${name.toUpperCase()}**`);
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Replace each known name (longest-first, regex-safe, case-sensitive, skipping partial-word/
 *  backticked matches) with `render(name)`. Backs the recap backticker (visual). The audio
 *  script builder uses `replaceNamesForSpeech` instead — it must catch every emphasis variant. */
export function replaceNames(text: string, names: string[], render: (name: string) => string): string {
  let out = text ?? "";
  const list = [...new Set((names ?? []).filter((g) => typeof g === "string" && g.length))].sort(
    (a, b) => b.length - a.length
  );
  for (const g of list) {
    const re = new RegExp(`(?<![\`\\w])${escapeRe(g)}(?![\`\\w])`, "g");
    out = out.replace(re, render(g));
  }
  return out;
}

/**
 * Speech variant of `replaceNames`: replace EVERY occurrence of each known name with
 * `render(name)`, matching **case-insensitively** and regardless of surrounding backticks,
 * asterisks, or ALL-CAPS emphasis — because the TTS must never receive a raw gamertag, and a
 * host may repeat a name LOUDER or in `code` for emphasis. Boundaries are alphanumeric (so
 * punctuation/backticks/markdown don't block a match); still longest-first and partial-word-safe.
 * `render` always receives the CANONICAL name, so the spoken form stays the one frozen for that tag.
 */
export function replaceNamesForSpeech(text: string, names: string[], render: (name: string) => string): string {
  let out = text ?? "";
  const list = [...new Set((names ?? []).filter((g) => typeof g === "string" && g.length))].sort(
    (a, b) => b.length - a.length
  );
  for (const g of list) {
    const re = new RegExp(`(?<![A-Za-z0-9])${escapeRe(g)}(?![A-Za-z0-9])`, "gi");
    out = out.replace(re, () => render(g));
  }
  return out;
}

/**
 * Wrap each known gamertag in backticks where it appears un-backticked. Longest-first
 * so a name that contains another isn't half-matched; lookarounds skip occurrences
 * already inside backticks and partial-word matches.
 */
export function backtickNames(text: string, gamertags: string[] = []): string {
  return replaceNames(text, gamertags, (g) => "`" + g + "`");
}

/** Full banter formatting: bold-caps hosts + backticked gamertags. */
export function formatBanter(text: string, gamertags: string[] = []): string {
  return backtickNames(boldHostNames(text), gamertags);
}
