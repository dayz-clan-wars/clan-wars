import type { APIEmbed } from "discord.js";

/**
 * What rendering needs from a queued release.
 *
 * ⚠️ Declared here rather than imported from `release-tick.ts`, which imports
 * `releaseEmbeds` from this file. `QueuedRelease` satisfies it structurally.
 */
export interface ReleaseNotes {
  version: string;
  title: string | null;
  body: string;
  releasedAt: Date;
}

/** Discord's cap on an embed description. The only size limit in play here. */
export const EMBED_DESCRIPTION_MAX = 4096;

/** Faction-feed blue, so the release posts read as the same system. */
const COLOR = 0x5865f2;

/**
 * Split the body into pieces that each fit an embed, preferring the largest
 * markdown boundary that works: `###` sections, then blank-line paragraph
 * breaks, then a hard cut.
 *
 * ⚠️ Every split is by INDEX, never `String.split` on a consuming pattern, so
 * the pieces concatenate back to the input EXACTLY. That is the whole promise
 * of this file. A consuming split drops the whitespace it matched; a trim plus
 * a fixed separator replaces a run of any length with two characters. Both are
 * invisible in Discord, and both only surface once a boundary lands at an embed
 * edge — by which point the notes have already been posted, wrong, for good.
 */
function pieces(body: string): string[] {
  const out: string[] = [];
  for (const section of splitAt(body, sectionStarts(body))) {
    if (section.length <= EMBED_DESCRIPTION_MAX) {
      out.push(section);
      continue;
    }
    for (const paragraph of splitAt(section, paragraphStarts(section))) {
      if (paragraph.length <= EMBED_DESCRIPTION_MAX) {
        out.push(paragraph);
        continue;
      }
      for (let i = 0; i < paragraph.length; i += EMBED_DESCRIPTION_MAX) {
        out.push(paragraph.slice(i, i + EMBED_DESCRIPTION_MAX));
      }
    }
  }
  return out;
}

/** The index of the `#` of every `### ` heading that starts a line. */
function sectionStarts(text: string): number[] {
  const out: number[] = [];
  const re = /\n### /gu;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) out.push(m.index + 1);
  return out;
}

/** The index of the first character AFTER each run of two or more newlines. */
function paragraphStarts(text: string): number[] {
  const out: number[] = [];
  const re = /\n{2,}/gu;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) out.push(m.index + m[0].length);
  return out;
}

/** Slice `text` at the given indices. The pieces always rejoin to `text`. */
function splitAt(text: string, starts: number[]): string[] {
  const bounds = [0, ...starts, text.length];
  const out: string[] = [];
  for (let i = 0; i < bounds.length - 1; i += 1) {
    const piece = text.slice(bounds[i]!, bounds[i + 1]!);
    if (piece !== "") out.push(piece);
  }
  return out;
}

/**
 * Greedily refill pieces into as few embeds as fit.
 *
 * ⚠️ Joined with nothing at all. `pieces()` leaves every character, whitespace
 * included, on the piece it came from — so a separator here would ADD text the
 * body never had, and a trim before joining would REMOVE text it did.
 */
function pack(parts: string[]): string[] {
  const out: string[] = [];
  let buf = "";
  for (const part of parts) {
    if (buf.length + part.length <= EMBED_DESCRIPTION_MAX) {
      buf += part;
      continue;
    }
    if (buf !== "") out.push(buf);
    buf = part;
  }
  if (buf !== "") out.push(buf);
  return out;
}

/**
 * A release as the embeds to post, in order.
 *
 * ⚠️ Only the first carries the title, and every piece past the first carries
 * `n/total` — otherwise a split release reads in the channel as several
 * releases with the same version number.
 */
export function releaseEmbeds(notes: ReleaseNotes): APIEmbed[] {
  const heading = notes.title === null ? `v${notes.version}` : `v${notes.version} — ${notes.title}`;
  const bodies = notes.body.trim() === "" ? [""] : pack(pieces(notes.body.trim()));

  return bodies.map((description, i) => ({
    ...(i === 0 ? { title: heading } : {}),
    description,
    color: COLOR,
    timestamp: notes.releasedAt.toISOString(),
    ...(bodies.length > 1 ? { footer: { text: `${i + 1}/${bodies.length}` } } : {}),
  }));
}
