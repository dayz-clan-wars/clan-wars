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
 * Split a body into pieces that each fit an embed, preferring the largest
 * markdown boundary that works: `###` sections, then paragraphs, then a hard
 * cut. A hard cut is ugly; dropping the overflow would be a silent loss.
 */
function pieces(body: string): string[] {
  const out: string[] = [];
  for (const section of body.split(/\n(?=### )/u)) {
    if (section.length <= EMBED_DESCRIPTION_MAX) {
      out.push(section);
      continue;
    }
    for (const paragraph of section.split(/\n{2,}/u)) {
      if (paragraph.length <= EMBED_DESCRIPTION_MAX) {
        out.push(paragraph);
        continue;
      }
      for (let i = 0; i < paragraph.length; i += EMBED_DESCRIPTION_MAX) {
        out.push(paragraph.slice(i, i + EMBED_DESCRIPTION_MAX));
      }
    }
  }
  return out.filter((p) => p !== "");
}

/** Greedily refill pieces into as few embeds as fit. */
function pack(parts: string[]): string[] {
  const out: string[] = [];
  let buf = "";
  for (const part of parts) {
    const next = buf === "" ? part : `${buf}\n\n${part}`;
    if (next.length <= EMBED_DESCRIPTION_MAX) {
      buf = next;
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
